import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDir, tryStatePath } from "../system/state-dir.js";
import { DOCKER_BIN } from "./docker-args.js";

export const PULLS_FILE = "pulls.json";
export const DAILY_MS = 24 * 60 * 60 * 1000;
const PULL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * `always`, `missing` and `never` mean what `docker run --pull` means. `daily`, the default,
 * is `missing` plus a pull once a day, so a rebuilt image reaches every machine without
 * every launch waiting on the registry.
 */
export function shouldPull(input: { policy: string | undefined; present: boolean; lastPulledAt: number | null; now: number }): Decision {
  const policy = input.policy === undefined || input.policy === "" ? "daily" : input.policy;
  if (policy === "never") {
    return { yes: false, reason: "SOL_PULL=never" };
  }
  if (policy === "always") {
    return { yes: true, reason: "SOL_PULL=always" };
  }
  if (policy !== "missing" && policy !== "daily") {
    throw new Error(`SOL_PULL=${policy} is not daily, always, missing or never`);
  }
  if (!input.present) {
    return { yes: true, reason: "the image is not on this machine yet" };
  }
  if (policy === "missing") {
    return { yes: false, reason: "SOL_PULL=missing and the image is already on this machine" };
  }
  if (input.lastPulledAt === null || input.now - input.lastPulledAt >= DAILY_MS) {
    return { yes: true, reason: "sol has not checked for a newer image today" };
  }
  return { yes: false, reason: "sol already checked for a newer image today" };
}

/** Pure: the user an image runs as, from `docker image inspect`'s `Config.User`. A bare uid or `user:group` is passed on as written. */
export function imageUser(configUser: string): string | undefined {
  const user = configUser.trim();
  return user === "" ? undefined : user;
}

export async function imagePresent(deps: { runner: Runner }, image: string): Promise<boolean> {
  return (await deps.runner.run([DOCKER_BIN, "image", "inspect", "-f", "{{.Id}}", image])).code === 0;
}

export async function inspectImageUser(deps: { runner: Runner }, image: string): Promise<string | undefined> {
  const result = await deps.runner.run([DOCKER_BIN, "image", "inspect", "-f", "{{.Config.User}}", image]);
  return result.code === 0 ? imageUser(result.stdout) : undefined;
}

/** A failed pull is only fatal when there is no copy of the image to fall back on. */
export async function pullImage(deps: PullDeps, input: { image: string; policy: string | undefined }): Promise<void> {
  const present = await imagePresent(deps, input.image);
  const pulls = await readPulls(deps);
  const decision = shouldPull({ policy: input.policy, present, lastPulledAt: pulls[input.image] ?? null, now: deps.clock.now() });
  deps.logger.verbose(`${input.image}: ${decision.reason}`);
  if (!decision.yes) {
    return;
  }
  if (!present) {
    deps.logger.say(`pulling ${input.image}; the first pull takes a while`);
  }
  const pulled = await deps.runner.run([DOCKER_BIN, "pull", input.image], { timeoutMs: PULL_TIMEOUT_MS });
  if (pulled.code !== 0) {
    if (!present) {
      throw new Error(`could not pull ${input.image}: ${pulled.stderr.trim()}`);
    }
    deps.logger.verbose(`could not check for a newer ${input.image}, so the copy on this machine is used: ${pulled.stderr.trim()}`);
    return;
  }
  await writePulls(deps, { ...pulls, [input.image]: deps.clock.now() });
}

async function readPulls(deps: { fs: Fs; env: Env }): Promise<Record<string, number>> {
  const path = tryStatePath(deps.env, PULLS_FILE);
  const text = path === null ? null : await deps.fs.readText(path);
  try {
    const parsed = JSON.parse(text ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function writePulls(deps: { fs: Fs; env: Env }, pulls: Record<string, number>): Promise<void> {
  const path = tryStatePath(deps.env, PULLS_FILE);
  if (path === null) {
    return;
  }
  await deps.fs.mkdirp(stateDir(deps.env), { mode: STATE_DIR_MODE });
  await deps.fs.writeText(path, `${JSON.stringify(pulls)}\n`, { mode: STATE_FILE_MODE });
}

export interface Decision {
  yes: boolean;
  reason: string;
}

export interface PullDeps {
  runner: Runner;
  fs: Fs;
  env: Env;
  clock: Clock;
  logger: Logger;
}
