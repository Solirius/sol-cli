export const CLAUDE_BIN = "claude";

/** sol has no arguments of its own: everything after the executable goes to `claude` verbatim, with no parsing step. */
export function forwardArgv(processArgv: string[]): string[] {
  return processArgv.slice(2);
}

export function buildClaudeArgs(input: { settings?: string; userArgs: string[] }): string[] {
  const argv = [CLAUDE_BIN];
  if (input.settings !== undefined) {
    argv.push("--settings", input.settings);
  }
  return [...argv, ...input.userArgs];
}
