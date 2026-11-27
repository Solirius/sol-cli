import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packagedRuntimeDir } from "../container/runtime-staging.js";
import { parseRegistry } from "../solr/registry.js";
import { createFs } from "../system/fs.js";
import { createRunner } from "../system/runner.js";

/**
 * runtime/hook.sh, run by a real sh: it has to write the very records the TypeScript
 * registry reads, from inside any image, with nothing but POSIX tools.
 */
const fs = createFs();
const runner = createRunner();
const script = join(packagedRuntimeDir(), "hook.sh");
let dir = "";

async function hook(event: string, payload: object, env: Record<string, string> = {}, args: string[] = []) {
  dir ||= join(tmpdir(), `sol-hook-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const result = await runner.run(["sh", script, event, ...args], {
    stdin: JSON.stringify(payload),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CONFIG_DIR: dir, ...env }
  });
  return { code: result.code, text: await fs.readText(join(dir, "sessions.jsonl")) };
}

const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "42", SOL_CONTAINER_NAME: "sol-repo-1234abcd" };
const PROMPT = { session_id: "abc-1", cwd: '/work/a "quoted" dir', transcript_path: "/x/projects/-work-a/abc-1.jsonl", prompt: 'say "session_id":"nope"' };

afterEach(async () => {
  if (dir !== "") {
    await fs.remove(dir);
    dir = "";
  }
});

describe("runtime/hook.sh", () => {
  it("should register an attended prompt as the registry's own record", async () => {
    // Act
    const { code, text } = await hook("UserPromptSubmit", PROMPT, ATTENDED, ["--name", 'the "pcs" one']);

    // Assert
    expect(code).toBe(0);
    expect(parseRegistry(text)).toEqual([
      {
        sessionId: "abc-1",
        cwd: '/work/a "quoted" dir',
        state: "open",
        at: expect.any(Number),
        pid: 42,
        name: 'the "pcs" one',
        container: "sol-repo-1234abcd",
        slug: "-work-a"
      }
    ]);
  });

  it("should write one line per conversation however many prompts it gets", async () => {
    // Act
    await hook("UserPromptSubmit", PROMPT, ATTENDED);
    const { text } = await hook("UserPromptSubmit", PROMPT, ATTENDED);

    // Assert
    expect(text?.trim().split("\n")).toHaveLength(1);
  });

  it("should register again when the session moves to a new process", async () => {
    // Act
    await hook("UserPromptSubmit", PROMPT, ATTENDED);
    const { text } = await hook("UserPromptSubmit", PROMPT, { ...ATTENDED, CLAUDE_PID: "43" });

    // Assert
    expect(parseRegistry(text)[0]?.pid).toBe(43);
  });

  it("should ignore a session nobody is attending", async () => {
    // Act
    const { code, text } = await hook("UserPromptSubmit", PROMPT, { CLAUDE_PID: "42" });

    // Assert
    expect(code).toBe(0);
    expect(text).toBeNull();
  });

  it("should close a conversation the person ended", async () => {
    // Act
    await hook("UserPromptSubmit", PROMPT, ATTENDED);
    const { text } = await hook("SessionEnd", { ...PROMPT, reason: "prompt_input_exit" });

    // Assert
    expect(parseRegistry(text)[0]?.state).toBe("closed");
  });

  it("should leave a killed session open, which is what makes it restorable", async () => {
    // Act
    await hook("UserPromptSubmit", PROMPT, ATTENDED);
    const { text } = await hook("SessionEnd", { ...PROMPT, reason: "other" });

    // Assert
    expect(parseRegistry(text)[0]?.state).toBe("open");
  });

  it.each<[string, string, object]>([
    ["a payload with no session", "UserPromptSubmit", { cwd: "/work" }],
    ["an event it does not maintain the registry from", "SessionStart", PROMPT]
  ])("should do nothing for %s", async (_name, event, payload) => {
    // Act
    const { code, text } = await hook(event, payload, ATTENDED);

    // Assert
    expect(code).toBe(0);
    expect(text).toBeNull();
  });

  it("should record no pid when the one it is given is not a number", async () => {
    // Act
    const { text } = await hook("UserPromptSubmit", PROMPT, { ...ATTENDED, CLAUDE_PID: "x1" });

    // Assert
    expect(parseRegistry(text)[0]?.pid).toBe(0);
  });
});
