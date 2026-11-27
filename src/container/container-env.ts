import type { Env } from "../system/env.js";

/**
 * Only these are carried over from the host's environment: `docker run --env` is recorded in
 * the container config, so forwarding the lot would put whatever the shell holds on disk.
 */
export const PASSTHROUGH = ["SOL_VERBOSE", "SOL_OFFLINE", "SOL_NO_UPDATE", "TERM", "COLORTERM", "LANG"];

export function passthroughEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      out[name] = value;
    }
  }
  return out;
}
