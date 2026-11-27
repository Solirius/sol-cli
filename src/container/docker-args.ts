import { CLAUDE_CONFIG_DIR } from "../volume/volume-fs.js";
import { type Mount, renderMount } from "./mounts.js";

export const DOCKER_BIN = "docker";

/** The major tag, so a rebuilt image reaches everyone on their next pull without a CLI release. */
export const DEFAULT_IMAGE = "ghcr.io/solirius/devcontainer:1";

/** Read-only, and invoked as `sh <script>` so the staged copies need no execute bit. */
export const RUNTIME_MOUNT_POINT = "/opt/sol";
export const SUPERVISOR = `${RUNTIME_MOUNT_POINT}/supervisor.sh`;
export const ENTRYPOINT = `${RUNTIME_MOUNT_POINT}/entrypoint.sh`;
export const INSTALL_CLAUDE = `${RUNTIME_MOUNT_POINT}/install-claude.sh`;

/** Where Claude Code is installed for an image that does not ship it, shared by every such image. */
export const TOOLS_MOUNT_POINT = "/opt/sol-tools";
export const DEFAULT_TOOLS_VOLUME = "sol-tools";

/** Alpine's busybox wget speaks TLS, which is all the installer needs. */
export const DOWNLOAD_HELPER_IMAGE = "alpine:3.24";
/** `install-claude.sh`'s answer for "nothing here can download". */
export const NO_DOWNLOADER_CODE = 3;

export const NESTED_DOCKER_DIR = "/var/lib/docker";

/**
 * The whole `docker run` argv. The container runs as root because dockerd needs to; each
 * session then execs as the image's user. The entrypoint is replaced, so an image built
 * with one of its own still starts the supervisor.
 */
export function buildDockerArgs(ctx: ContainerContext): string[] {
  const argv = [
    DOCKER_BIN,
    "run",
    "-d",
    "--name",
    ctx.sessionName,
    "--user",
    "0:0",
    "--privileged",
    "--init",
    // Its own namespace: a second dockerd sharing the host's flushes the host daemon's iptables chains.
    "--network",
    ctx.network,
    "--shm-size=2g",
    "--ulimit",
    "nofile=65536:65536",
    "--cgroupns=private",
    "--tmpfs",
    "/run:exec,mode=0755",
    "--mount",
    renderMount({ kind: "volume", source: ctx.dockerVolume, target: NESTED_DOCKER_DIR }),
    "--mount",
    renderMount({ kind: "volume", source: ctx.claudeVolume, target: CLAUDE_CONFIG_DIR }),
    "--mount",
    renderMount({ kind: "volume", source: ctx.toolsVolume, target: TOOLS_MOUNT_POINT }),
    // At its own host path, so Claude Code's project slug is the same whichever container a directory gets.
    "--mount",
    renderMount({ kind: "bind", source: ctx.repoPath, target: ctx.repoPath })
  ];
  for (const mount of ctx.mounts) {
    argv.push("--mount", renderMount(mount));
  }
  argv.push("--mount", renderMount({ kind: "bind", source: ctx.runtimeDir, target: RUNTIME_MOUNT_POINT, readonly: true }), "-w", ctx.workdir);
  for (const [name, value] of sorted(ctx.env)) {
    argv.push("--env", `${name}=${value}`);
  }
  return [...argv, ...ctx.runArgs, "--entrypoint", "sh", ctx.image, SUPERVISOR];
}

/**
 * The interactive session: a second exec, as the image's user. Per-session environment goes
 * here rather than on the create, because a reattaching terminal brings its own.
 */
export function buildSessionExecArgs(ctx: ContainerContext, claudeArgv: string[]): string[] {
  const argv = [DOCKER_BIN, "exec", "-i"];
  if (ctx.tty) {
    argv.push("-t");
  }
  argv.push("--user", ctx.containerUser, "-w", ctx.workdir);
  for (const [name, value] of sorted(ctx.sessionEnv)) {
    argv.push("--env", `${name}=${value}`);
  }
  return [...argv, ctx.sessionName, "sh", ENTRYPOINT, ...claudeArgv];
}

/** Whether the session will find claude: on the image's PATH, or already installed into the tools volume. */
export function buildClaudeProbeArgs(ctx: ContainerContext): string[] {
  return [DOCKER_BIN, "exec", "--user", ctx.containerUser, ctx.sessionName, "sh", ENTRYPOINT, "claude", "--version"];
}

/** As root, because the tools volume is shared by every image and owned by none of their users. */
export function buildInstallClaudeArgs(ctx: ContainerContext): string[] {
  return [DOCKER_BIN, "exec", "--user", "0", ctx.sessionName, "sh", INSTALL_CLAUDE];
}

export function buildClaudePlatformArgs(ctx: ContainerContext): string[] {
  return [DOCKER_BIN, "exec", ctx.sessionName, "sh", INSTALL_CLAUDE, "--platform"];
}

/** For an image with no curl or wget: the download runs beside it, into the same volume, for the platform the image needs. */
export function buildHelperInstallArgs(ctx: ContainerContext, platform: string): string[] {
  return [
    DOCKER_BIN,
    "run",
    "--rm",
    "--mount",
    renderMount({ kind: "volume", source: ctx.toolsVolume, target: TOOLS_MOUNT_POINT }),
    "--mount",
    renderMount({ kind: "bind", source: ctx.runtimeDir, target: RUNTIME_MOUNT_POINT, readonly: true }),
    DOWNLOAD_HELPER_IMAGE,
    "sh",
    INSTALL_CLAUDE,
    platform
  ];
}

function sorted(env: Record<string, string>): [string, string][] {
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
}

export interface ContainerContext {
  image: string;
  sessionName: string;
  network: string;
  platform: string;
  /** The git toplevel, bind-mounted at this same path inside. */
  repoPath: string;
  /** Where the session starts: the cwd, which is the repo path unless sol was run from a subdirectory. */
  workdir: string;
  /** The user each session execs as: the devcontainer's, else the image's own, else root. */
  containerUser: string;
  dockerVolume: string;
  claudeVolume: string;
  toolsVolume: string;
  /** The host directory holding the staged runtime scripts. */
  runtimeDir: string;
  /** 0.0.0.0 rather than loopback for each sidecar's mapping, which SOL_PORTS_PUBLIC=1 asks for. */
  publicPorts: boolean;
  /** devcontainer.json's `forwardPorts`, published as soon as the container is up. */
  forwardPorts: number[];
  mounts: Mount[];
  /** devcontainer.json's `runArgs`, less the network flags. */
  runArgs: string[];
  tty: boolean;
  /** Facts about the whole container, recorded in its config: the markers, `containerEnv`, the passthrough. */
  env: Record<string, string>;
  /** This terminal's own: `remoteEnv` and anything only one session should see. */
  sessionEnv: Record<string, string>;
}
