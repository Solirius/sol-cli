import { join } from "node:path";
import { buildClaudeArgs } from "../claude/args.js";
import { sessionRegistryHooks } from "../claude/hooks.js";
import { buildSettings, materialiseSettings } from "../claude/settings.js";
import { extractUserSettings, mergeSettings, readUserSettings } from "../claude/user-settings.js";
import { CONTAINER_ENV } from "../solr/hook.js";
import { isEnabled } from "../system/env.js";
import type { RunResult } from "../system/runner.js";
import type { Seams } from "../system/seams.js";
import { CLAUDE_CONFIG_DIR, createVolumeFs, DEFAULT_CLAUDE_VOLUME, execTransport } from "../volume/volume-fs.js";
import { seedClaudeJson } from "./claude-json.js";
import { passthroughEnv } from "./container-env.js";
import {
  buildClaudePlatformArgs,
  buildClaudeProbeArgs,
  buildDockerArgs,
  buildHelperInstallArgs,
  buildInstallClaudeArgs,
  buildSessionExecArgs,
  type ContainerContext,
  DEFAULT_IMAGE,
  DEFAULT_TOOLS_VOLUME,
  DOCKER_BIN,
  NO_DOWNLOADER_CODE
} from "./docker-args.js";
import { hostPrepPaths } from "./host-prep.js";
import { inspectImageUser, pullImage } from "./image.js";
import { DEFAULT_CONTAINER_USER, type DevcontainerSpec, defaultSpec, type Mount, parseDevcontainer, resolveMounts, type SubstitutionVars } from "./mounts.js";
import { type PortWatch, startPortWatch, sweepSidecars } from "./port-watch.js";
import { attach, detach, withSessionLock } from "./refs.js";
import { stagedRuntimeDir, stageRuntime } from "./runtime-staging.js";
import { dockerVolumeName, NETWORK_NAME, sessionName } from "./session.js";

const START_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const READY_ATTEMPTS = 90;
const READY_POLL_MS = 1000;
export const ROOT_USER = "root";

/** Where the host's SSH agent appears inside, whichever platform it came from. */
export const SSH_AGENT_TARGET = "/ssh-agent.sock";
/** Docker Desktop's own forwarding of the macOS agent; the host's socket path cannot be bind-mounted from a VM. */
export const DOCKER_DESKTOP_SSH_AGENT = "/run/host-services/ssh-auth.sock";

/**
 * Container mode: Claude Code inside the session container for this directory, started if
 * no other terminal has it up already, and removed when the last terminal using it leaves.
 */
export async function runContainerMode(input: { seams: Seams; forwarded: string[] }): Promise<void> {
  const { seams } = input;
  const dryRun = isEnabled(seams.env, "SOL_DRY_RUN");
  const gathered = await gatherContext(seams);

  if (dryRun) {
    const ctx = await withUser(seams, gathered, gathered.spec);
    seams.stdout(`${buildDockerArgs(ctx).join(" ")}\n`);
    seams.stdout(`${buildSessionExecArgs(ctx, await containerClaudeArgs(input)).join(" ")}\n`);
    seams.exit(0);
  }

  await prepareHost(seams, gathered);
  const claudeArgv = await containerClaudeArgs(input);

  let ctx: ContainerContext | null = null;
  let started = false;
  let watch: PortWatch | null = null;
  let code = 1;
  try {
    ({ ctx, started } = await withSessionLock(seams, gathered.sessionName, async () => {
      await attach(seams, gathered.sessionName);
      const running = await sessionRunning(seams, gathered.sessionName);
      if (!running) {
        await sweepSidecars(seams, gathered.sessionName);
        await pullImage(seams, { image: gathered.image, policy: seams.env.SOL_PULL });
      }
      const resolved = await withUser(seams, gathered, gathered.spec);
      await ensureNetwork(seams, resolved.network);
      const didStart = await ensureContainer(seams, resolved, running);
      return { ctx: resolved, started: didStart };
    }));
    await seedClaudeJson(
      { fs: createVolumeFs(seams, execTransport(ctx.sessionName)) },
      { home: CLAUDE_CONFIG_DIR, workspacePath: ctx.workdir, pid: seams.pid }
    );
    await ensureClaude(seams, ctx);
    // Only the terminal that started the container watches it: two watchers would race for the same ports.
    if (started) {
      watch = await startPortWatch(seams, ctx);
    }
    code = await seams.runner.interactive(buildSessionExecArgs(ctx, claudeArgv));
  } finally {
    await watch?.stop();
    await leave(seams, gathered.sessionName);
  }
  seams.exit(code);
}

/** Everything but the user, which can only be read off the image once it has been pulled. */
type Gathered = Omit<ContainerContext, "containerUser"> & { home: string; spec: DevcontainerSpec };

async function gatherContext(seams: Seams): Promise<Gathered> {
  const home = seams.env.HOME;
  if (home === undefined || home === "") {
    throw new Error("HOME is not set, so there is no way to work out what to mount into the container");
  }
  const repoPath = await gitToplevel(seams);
  const session = sessionName({ repoPath, requested: seams.env.SOL_SESSION });
  seams.logger.verbose(`container session ${session} for ${repoPath}`);

  const spec = await readSpec(seams, repoPath);
  const image = nonEmpty(seams.env.SOL_IMAGE) ?? spec.image ?? DEFAULT_IMAGE;
  const mounts = [...(await presentMounts(seams, resolveMounts({ spec, extra: seams.env.SOL_MOUNTS }))), ...(await sshAgentMounts(seams))];
  const runtimeDir = isEnabled(seams.env, "SOL_DRY_RUN") ? stagedRuntimeDir(seams.env) : await stageRuntime(seams);
  const claudeVolume = nonEmpty(seams.env.SOL_CLAUDE_VOLUME) ?? DEFAULT_CLAUDE_VOLUME;

  return {
    image,
    sessionName: session,
    network: NETWORK_NAME,
    platform: seams.platform,
    repoPath,
    workdir: seams.cwd,
    dockerVolume: dockerVolumeName(session),
    claudeVolume,
    toolsVolume: DEFAULT_TOOLS_VOLUME,
    runtimeDir,
    publicPorts: isEnabled(seams.env, "SOL_PORTS_PUBLIC"),
    forwardPorts: spec.forwardPorts,
    mounts,
    runArgs: spec.runArgs,
    tty: seams.hiddenInput.isTty,
    env: {
      ...passthroughEnv(seams.env),
      ...(await gitIdentity(seams)),
      ...(await hostIds(seams)),
      ...spec.containerEnv,
      ...(mounts.some((mount) => mount.target === SSH_AGENT_TARGET) ? { SSH_AUTH_SOCK: SSH_AGENT_TARGET } : {}),
      SOL_IN_CONTAINER: "1",
      SOL_ENV_READY: "1",
      // No --pid=host, so a pid recorded inside means nothing on the host; the container name does.
      [CONTAINER_ENV]: session,
      CLAUDE_CONFIG_DIR,
      // The image is the release: a claude that updated itself would be gone with the container.
      DISABLE_AUTOUPDATER: "1",
      SOL_USER_DIRS: [CLAUDE_CONFIG_DIR, ...mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.target)].join(",")
    },
    sessionEnv: spec.remoteEnv,
    home,
    spec
  };
}

/** The devcontainer's user, else the image's own, else root; and sol's own image's user is remapped onto the host's uid. */
async function withUser(seams: Seams, gathered: Gathered, spec: DevcontainerSpec): Promise<ContainerContext> {
  const { home: _home, spec: _spec, ...ctx } = gathered;
  const containerUser = spec.user ?? (await inspectImageUser(seams, gathered.image)) ?? ROOT_USER;
  return {
    ...ctx,
    containerUser,
    env: {
      ...ctx.env,
      SOL_CONTAINER_USER: containerUser,
      ...(containerUser === DEFAULT_CONTAINER_USER ? { SOL_REMAP_USER: "1" } : {})
    }
  };
}

async function containerClaudeArgs(input: { seams: Seams; forwarded: string[] }): Promise<string[]> {
  const { seams } = input;
  const user = extractUserSettings(input.forwarded);
  const ours = buildSettings({ hooks: sessionRegistryHooks(seams, { forwarded: input.forwarded, forContainer: true }) });
  const merged = mergeSettings(ours, user.value === undefined ? {} : await readUserSettings(seams, user.value));
  for (const warning of merged.warnings) {
    seams.logger.say(warning);
  }
  return buildClaudeArgs({ settings: materialiseSettings(merged.settings), userArgs: user.argv });
}

/** devcontainer.json's initializeCommand, in sol: every bind source under HOME has to exist first. */
async function prepareHost(seams: Seams, ctx: { home: string; mounts: Mount[] }): Promise<void> {
  const { dirs, files } = hostPrepPaths({ home: ctx.home, mounts: ctx.mounts });
  for (const dir of dirs) {
    // A file there already (a ~/.gitconfig) is what the mount wants; mkdir -p would throw on it.
    if (!(await seams.fs.exists(dir))) {
      await seams.fs.mkdirp(dir);
    }
  }
  for (const file of files) {
    if (!(await seams.fs.exists(file))) {
      await seams.fs.writeText(file, "");
    }
  }
}

/** The binds sol adds on its own account are conveniences: one the host has nothing at is left out rather than created. */
async function presentMounts(seams: Seams, mounts: Mount[]): Promise<Mount[]> {
  const kept: Mount[] = [];
  for (const mount of mounts) {
    if (mount.optional !== true || (await seams.fs.exists(mount.source))) {
      const { optional: _optional, ...rest } = mount;
      kept.push(rest);
    }
  }
  return kept;
}

async function sshAgentMounts(seams: Seams): Promise<Mount[]> {
  if (isEnabled(seams.env, "SOL_NO_SSH_AGENT")) {
    return [];
  }
  if (seams.platform === "darwin") {
    return [{ kind: "bind", source: DOCKER_DESKTOP_SSH_AGENT, target: SSH_AGENT_TARGET }];
  }
  const socket = nonEmpty(seams.env.SSH_AUTH_SOCK);
  return socket !== undefined && (await seams.fs.exists(socket)) ? [{ kind: "bind", source: socket, target: SSH_AGENT_TARGET }] : [];
}

async function ensureNetwork(seams: Seams, network: string): Promise<void> {
  if ((await seams.runner.run([DOCKER_BIN, "network", "inspect", network])).code === 0) {
    return;
  }
  const created = await seams.runner.run([DOCKER_BIN, "network", "create", network]);
  if (created.code !== 0) {
    throw new Error(`could not create the ${network} Docker network: ${created.stderr.trim()}`);
  }
}

function inspectRunning(seams: Seams, name: string): Promise<RunResult> {
  return seams.runner.run([DOCKER_BIN, "inspect", "-f", "{{.State.Running}}", name]);
}

async function sessionRunning(seams: Seams, name: string): Promise<boolean> {
  const existing = await inspectRunning(seams, name);
  return existing.code === 0 && existing.stdout.trim() === "true";
}

/** True when this run started the container. */
async function ensureContainer(seams: Seams, ctx: ContainerContext, running: boolean): Promise<boolean> {
  if (running) {
    seams.logger.verbose(`${ctx.sessionName} is already up, so this terminal joins it`);
    return false;
  }
  // Stopped, not gone: a container left behind by a machine that went down mid-session.
  await seams.runner.run([DOCKER_BIN, "rm", "-f", ctx.sessionName], { timeoutMs: START_TIMEOUT_MS });
  const created = await seams.runner.run(buildDockerArgs(ctx), { timeoutMs: START_TIMEOUT_MS });
  if (created.code !== 0) {
    throw new Error(`could not start the sol container: ${created.stderr.trim()}`);
  }
  await waitUntilReady(seams, ctx);
  return true;
}

/** The supervisor remaps the session user before anything else, so no session may exec in ahead of it. */
async function waitUntilReady(seams: Seams, ctx: ContainerContext): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if ((await seams.runner.run([DOCKER_BIN, "exec", ctx.sessionName, "test", "-e", "/run/sol-ready"])).code === 0) {
      seams.logger.verbose(`${ctx.sessionName} is ready`);
      return;
    }
    await seams.clock.sleep(READY_POLL_MS);
  }
  seams.logger.say(`${ctx.sessionName} did not finish starting; see docker logs ${ctx.sessionName}`);
}

/** An image the repo chose need not ship claude: it is installed once into the shared tools volume. */
async function ensureClaude(seams: Seams, ctx: ContainerContext): Promise<void> {
  if ((await seams.runner.run(buildClaudeProbeArgs(ctx))).code === 0) {
    return;
  }
  seams.logger.say(`${ctx.image} has no claude, so it is being installed into the ${ctx.toolsVolume} volume for every image like it`);
  let installed = await seams.runner.run(buildInstallClaudeArgs(ctx), { timeoutMs: INSTALL_TIMEOUT_MS });
  if (installed.code === NO_DOWNLOADER_CODE) {
    const platform = (await seams.runner.run(buildClaudePlatformArgs(ctx))).stdout.trim();
    seams.logger.verbose(`${ctx.image} cannot download anything, so the ${platform} build is fetched from a helper container`);
    installed = await seams.runner.run(buildHelperInstallArgs(ctx, platform), { timeoutMs: INSTALL_TIMEOUT_MS });
  }
  if (installed.code !== 0) {
    throw new Error(`could not install claude into ${ctx.image}: ${(installed.stderr.trim() || installed.stdout.trim()).split("\n").slice(-5).join("\n")}`);
  }
}

/** Last one out removes the container; everyone else just detaches. */
async function leave(seams: Seams, name: string): Promise<void> {
  await withSessionLock(seams, name, async () => {
    const { othersAttached } = await detach(seams, name);
    if (othersAttached) {
      seams.logger.verbose(`${name} is still in use by another terminal, so it is left running`);
      return;
    }
    // The nested engine's image cache lives in the named volume, not in the container.
    await seams.runner.run([DOCKER_BIN, "rm", "-f", name], { timeoutMs: START_TIMEOUT_MS });
    seams.logger.verbose(`removed ${name}`);
    await sweepSidecars(seams, name);
  });
}

async function readSpec(seams: Seams, repoPath: string): Promise<DevcontainerSpec> {
  const vars: SubstitutionVars = { env: seams.env, workspaceFolder: repoPath };
  const path = join(repoPath, ".devcontainer", "devcontainer.json");
  const json = await seams.fs.readText(path);
  if (json === null) {
    return defaultSpec(vars);
  }
  const spec = parseDevcontainer(json, vars);
  if (spec === null) {
    seams.logger.say(`${path} is not a JSON object, so sol's defaults are used instead`);
    return defaultSpec(vars);
  }
  if (spec.unsupported.length > 0) {
    seams.logger.say(`${path} sets ${spec.unsupported.join(", ")}, which sol does not act on`);
  }
  seams.logger.verbose(`container from ${spec.source}`);
  return spec;
}

async function gitToplevel(seams: Seams): Promise<string> {
  const result = await seams.runner.run(["git", "rev-parse", "--show-toplevel"], { cwd: seams.cwd });
  const top = result.stdout.trim();
  return result.code === 0 && top !== "" ? top : seams.cwd;
}

async function gitIdentity(seams: Seams): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, name] of [
    ["user.name", "SOL_GIT_AUTHOR_NAME"],
    ["user.email", "SOL_GIT_AUTHOR_EMAIL"]
  ] as const) {
    const result = await seams.runner.run(["git", "config", "--global", "--get", key]);
    const value = result.stdout.trim();
    if (result.code === 0 && value !== "") {
      out[name] = value;
    }
  }
  return out;
}

/** Linux only: Docker Desktop maps ownership on its own, and there the host uid means nothing to the VM. */
async function hostIds(seams: Seams): Promise<Record<string, string>> {
  if (seams.platform !== "linux") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [flag, name] of [
    ["-u", "SOL_HOST_UID"],
    ["-g", "SOL_HOST_GID"]
  ] as const) {
    const result = await seams.runner.run(["id", flag]);
    const value = result.stdout.trim();
    if (result.code === 0 && /^\d+$/.test(value)) {
      out[name] = value;
    }
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
