import type { Runner } from "../system/runner.js";

/**
 * A pid is only meaningful in its own namespace; whether the container is still there is an
 * answer that crosses one.
 */
export async function containerRunning(deps: { runner: Runner }, name: string): Promise<boolean | null> {
  const result = await deps.runner.run(["docker", "inspect", "-f", "{{.State.Running}}", name]);
  if (result.code === 0) {
    return result.stdout.trim() === "true";
  }
  // "No such object" is a definite no. Anything else — no docker, no daemon — leaves the
  // question open, and an open question is not grounds to take someone else's claim.
  return /no such object/i.test(result.stderr) ? false : null;
}

/**
 * Liveness only, never identity: `ps -o comm=` reports `MainThread` for a plain node process,
 * so matching the command name to defeat a reused pid would read a live holder as gone.
 */
export async function pidAlive(deps: { runner: Runner }, pid: number): Promise<boolean | null> {
  const result = await deps.runner.run(["ps", "-p", String(pid), "-o", "pid="]);
  if (result.code === 0) {
    return result.stdout.trim() !== "";
  }
  return result.code === 1 ? false : null;
}

/**
 * A pid inside a running container, asked through the container's own shell. `kill -0` is a
 * builtin, so this needs nothing of the image beyond `sh`; the verdict is read off stdout so
 * a failed `docker exec` cannot pass for a dead process.
 */
export async function pidAliveInContainer(deps: { runner: Runner }, container: string, pid: number): Promise<boolean | null> {
  const result = await deps.runner.run([
    "docker",
    "exec",
    container,
    "sh",
    "-c",
    'if kill -0 "$1" 2>/dev/null; then echo alive; else echo dead; fi',
    "sh",
    String(pid)
  ]);
  const verdict = result.stdout.trim();
  if (result.code !== 0) {
    return null;
  }
  return verdict === "alive" ? true : verdict === "dead" ? false : null;
}
