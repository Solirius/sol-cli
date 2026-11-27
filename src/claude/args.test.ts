import { describe, expect, it } from "vitest";
import { buildClaudeArgs, CLAUDE_BIN, forwardArgv } from "./args.js";

describe("forwardArgv", () => {
  it.each<[string, string[]]>([
    ["no arguments at all", []],
    ["what looks like a subcommand", ["mcp", "list"]],
    ["something that looks like one of ours", ["--settings", "{}", "--dangerously-skip-permissions"]]
  ])("should forward %s untouched", (_name, userArgs) => {
    // Arrange
    const processArgv = ["/usr/local/bin/node", "/usr/local/bin/sol", ...userArgs];

    // Act
    const result = forwardArgv(processArgv);

    // Assert
    expect(result).toEqual(userArgs);
  });

  it("should not share the caller's array", () => {
    // Arrange
    const processArgv = ["node", "sol", "-c"];

    // Act
    const result = forwardArgv(processArgv);
    result.push("--mutated");

    // Assert
    expect(processArgv).toEqual(["node", "sol", "-c"]);
  });
});

describe("buildClaudeArgs", () => {
  it("should put the settings ahead of the user's own arguments", () => {
    // Act / Assert
    expect(buildClaudeArgs({ settings: "{}", userArgs: ["-c"] })).toEqual([CLAUDE_BIN, "--settings", "{}", "-c"]);
  });

  it("should add nothing of its own when there are no settings", () => {
    // Act
    const argv = buildClaudeArgs({ userArgs: ["mcp", "list"] });

    // Assert
    expect(argv).toEqual([CLAUDE_BIN, "mcp", "list"]);
  });

  it("should never skip permissions by itself, and pass the flag on when the user types it", () => {
    // Act
    const ours = buildClaudeArgs({ settings: "{}", userArgs: [] });
    const theirs = buildClaudeArgs({ settings: "{}", userArgs: ["--dangerously-skip-permissions"] });

    // Assert
    expect(ours).not.toContain("--dangerously-skip-permissions");
    expect(theirs).toEqual([CLAUDE_BIN, "--settings", "{}", "--dangerously-skip-permissions"]);
  });

  it("should keep the user arguments last so they can override our flags", () => {
    // Act
    const argv = buildClaudeArgs({ settings: "{}", userArgs: ["--model", "haiku"] });

    // Assert
    expect(argv.slice(-2)).toEqual(["--model", "haiku"]);
  });
});
