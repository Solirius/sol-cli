import { join } from "node:path";
import type { Logger } from "../log/logger.js";
import type { Clock } from "../system/clock.js";
import type { Env } from "../system/env.js";
import type { Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, statePath } from "../system/state-dir.js";
import { pidAlive } from "./liveness.js";

export const SESSIONS_DIR = "sessions";
export const LOCK_ATTEMPTS = 300;
export const LOCK_POLL_MS = 100;

/**
 * One empty file per `sol` process attached to a container, named by its pid. The container is
 * shared by every terminal in the same directory, so it is removed by whichever one leaves
 * last rather than by the one that happened to start it.
 */
export function refsDir(env: Env, sessionName: string): string {
  return statePath(env, join(SESSIONS_DIR, sessionName));
}

export function lockPath(env: Env, sessionName: string): string {
  return statePath(env, join(SESSIONS_DIR, `${sessionName}.lock`));
}

/** Pure over who holds the start/stop lock. A holder that cannot be asked about is waited for, never broken. */
export function lockDecision(input: { holder: number | null; alive: boolean | null }): "wait" | "break" {
  if (input.holder === null) {
    // Unreadable: the holder is mid-write, or the file is one this release did not write.
    return "wait";
  }
  return input.alive === false ? "break" : "wait";
}

/** Pure: the attached pids that are not this process, from a directory listing. */
export function otherRefs(names: string[], self: number): number[] {
  return names
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== self)
    .sort((a, b) => a - b);
}

/**
 * Serialises starting a container against removing it, so a terminal that has just decided
 * to reattach is never left holding a container its neighbour is about to `rm -f`.
 */
export async function withSessionLock<T>(deps: RefDeps, sessionName: string, run: () => Promise<T>): Promise<T> {
  const path = lockPath(deps.env, sessionName);
  await deps.fs.mkdirp(statePath(deps.env, SESSIONS_DIR), { mode: STATE_DIR_MODE });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (await deps.fs.createExclusive(path, `${deps.pid}\n`, { mode: STATE_FILE_MODE })) {
      try {
        return await run();
      } finally {
        await deps.fs.remove(path);
      }
    }
    const holder = parsePid(await deps.fs.readText(path));
    if (lockDecision({ holder, alive: holder === null ? null : await pidAlive(deps, holder) }) === "break") {
      deps.logger.verbose(`the sol process (pid ${holder}) that held ${path} is gone, so its lock is cleared`);
      await deps.fs.remove(path);
      continue;
    }
    await deps.clock.sleep(LOCK_POLL_MS);
  }
  throw new Error(`another sol has been starting or stopping ${sessionName} for too long; remove ${path} if nothing is`);
}

export async function attach(deps: { fs: Fs; env: Env; pid: number }, sessionName: string): Promise<void> {
  const dir = refsDir(deps.env, sessionName);
  await deps.fs.mkdirp(dir, { mode: STATE_DIR_MODE });
  await deps.fs.writeText(join(dir, String(deps.pid)), "", { mode: STATE_FILE_MODE });
}

/** Detaches this process and answers whether anything else is still attached, clearing the refs of processes that died without detaching. */
export async function detach(deps: RefDeps, sessionName: string): Promise<{ othersAttached: boolean }> {
  const dir = refsDir(deps.env, sessionName);
  await deps.fs.remove(join(dir, String(deps.pid)));
  let others = false;
  for (const pid of otherRefs(
    (await deps.fs.listDir(dir)).map((entry) => entry.name),
    deps.pid
  )) {
    // An unanswerable pid counts as attached: removing a container from under a live session is the worse mistake.
    if ((await pidAlive(deps, pid)) === false) {
      await deps.fs.remove(join(dir, String(pid)));
    } else {
      others = true;
    }
  }
  return { othersAttached: others };
}

function parsePid(text: string | null): number | null {
  const pid = Number(text?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export interface RefDeps {
  fs: Fs;
  env: Env;
  runner: Runner;
  clock: Clock;
  logger: Logger;
  pid: number;
}
