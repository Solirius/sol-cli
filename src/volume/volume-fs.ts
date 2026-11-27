import type { DirEntry, Fs } from "../system/fs.js";
import type { Runner } from "../system/runner.js";

/** Where the shared Claude volume is mounted in every container sol starts, and in its helper. */
export const VOLUME_HOME = "/var/lib/sol";
export const CLAUDE_CONFIG_DIR = `${VOLUME_HOME}/.claude`;
export const DEFAULT_CLAUDE_VOLUME = "sol-claude";

/** A few megabytes, and nothing of the session image is assumed: `sh`, `cat`, `stat` and `mv` are all it is used for. */
export const HELPER_IMAGE = "busybox:1.37.0";

/** `createExclusive`'s "someone else already had it", told apart from a failed write. */
const EXISTS_CODE = 3;

const OWN = `o=$(stat -c %u:%g ${CLAUDE_CONFIG_DIR}) && chown "$o" "$1" 2>/dev/null; true`;

/**
 * The `Fs` contract over the volume, so the registry, claims, transcript scans and the
 * `.claude.json` seed run unchanged against it. Each call is one `sh -c` in a container that
 * mounts the volume at `CLAUDE_CONFIG_DIR`; files are handed to the owner of the volume root,
 * which is the session user once any session has started.
 */
export function createVolumeFs(deps: { runner: Runner }, transport: string[]): Fs {
  const sh = (script: string, args: string[], stdin?: string) =>
    deps.runner.run([...transport, "sh", "-c", script, "sh", ...args], stdin === undefined ? {} : { stdin });
  const must = async (what: string, script: string, args: string[], stdin?: string) => {
    const result = await sh(script, args, stdin);
    if (result.code !== 0) {
      throw new Error(`could not ${what} ${args[0]} in the Claude volume: ${result.stderr.trim()}`);
    }
  };

  return {
    async readText(path) {
      const result = await sh('cat -- "$1"', [path]);
      return result.code === 0 ? result.stdout : null;
    },

    readLines(path) {
      return lines(sh('cat -- "$1"', [path]).then((result) => (result.code === 0 ? result.stdout : "")));
    },

    async writeText(path, content, opts = {}) {
      await must("write", `cat > "$1" && ${chmod(opts.mode)}${OWN}`, [path], content);
    },

    async appendText(path, content, opts = {}) {
      await must("append to", `cat >> "$1" && ${chmod(opts.mode)}${OWN}`, [path], content);
    },

    async createExclusive(path, content, opts = {}) {
      const result = await sh(
        `set -C; if ! { cat > "$1"; } 2>/dev/null; then [ -e "$1" ] && exit ${EXISTS_CODE}; exit 1; fi; ${chmod(opts.mode)}${OWN}`,
        [path],
        content
      );
      if (result.code === EXISTS_CODE) {
        return false;
      }
      if (result.code !== 0) {
        throw new Error(`could not create ${path} in the Claude volume: ${result.stderr.trim()}`);
      }
      return true;
    },

    async mkdirp(path, opts = {}) {
      await must("create", `mkdir -p "$1" && ${chmod(opts.mode)}${OWN}`, [path]);
    },

    async rename(from, to) {
      await must("rename", 'mv -- "$1" "$2"', [from, to]);
    },

    async remove(path) {
      await sh('rm -rf -- "$1"', [path]);
    },

    async exists(path) {
      return (await sh('[ -e "$1" ]', [path])).code === 0;
    },

    async isDirectory(path) {
      return (await sh('[ -d "$1" ]', [path])).code === 0;
    },

    async isWritable(path) {
      return (await sh('[ -w "$1" ]', [path])).code === 0;
    },

    async listDir(path) {
      const result = await sh(
        'for f in "$1"/* "$1"/.[!.]*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then echo "d ${f##*/}"; else echo "f ${f##*/}"; fi; done',
        [path]
      );
      return result.code === 0 ? parseListing(result.stdout) : [];
    }
  };
}

/** A throwaway container, for when no session container is up to `exec` into. */
export function helperTransport(volume: string): string[] {
  return ["docker", "run", "--rm", "-i", "--mount", `type=volume,source=${volume},target=${CLAUDE_CONFIG_DIR}`, HELPER_IMAGE];
}

/** A running session, which already mounts the volume at the same path, so no container has to start. */
export function execTransport(container: string): string[] {
  return ["docker", "exec", "-i", "--user", "0", container];
}

export function parseListing(stdout: string): DirEntry[] {
  return stdout
    .split("\n")
    .filter((line) => /^[df] ./.test(line))
    .map((line) => ({ name: line.slice(2), isDirectory: line.startsWith("d") }));
}

function chmod(mode: number | undefined): string {
  return mode === undefined ? "" : `chmod ${mode.toString(8)} "$1" && `;
}

async function* lines(text: Promise<string>): AsyncGenerator<string> {
  const all = (await text).split("\n");
  if (all.at(-1) === "") {
    all.pop();
  }
  yield* all;
}
