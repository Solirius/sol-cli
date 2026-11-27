import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf, type FakeSeams, packagedRuntime } from "./__fixtures__/fake-seams.js";
import { binPath, SOLR_BIN } from "./claude/hooks.js";
import { launch } from "./launch.js";
import { packageRoot } from "./update/self-update.js";

const HOME = "/home/dev";
const IN_CONTAINER = { "/.dockerenv": "" };
/**
 * The session-registry hooks sol adds to every conversation, written out rather than rebuilt
 * from `registrationHooks`: these strings are what `sh -c` inside the session actually runs.
 */
const HOOK_BIN = `'/usr/local/bin/node' '${binPath(SOLR_BIN)}' 'hook'`;
const HOOKS =
  `"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${HOOK_BIN} UserPromptSubmit"}]}],` +
  `"SessionEnd":[{"hooks":[{"type":"command","command":"${HOOK_BIN} SessionEnd"}]}]}`;
/** A published version, so the update check is not skipped as an unpublished local build. */
const PUBLISHED = { [`${packageRoot()}package.json`]: JSON.stringify({ version: "0.1.0" }) };
const NEWER = async () => new Response(JSON.stringify({ "dist-tags": { latest: "99.0.0" } }));

function seamsIn(env: Record<string, string> = {}, files: Record<string, string> = {}) {
  return createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1", ...env }, files: { ...IN_CONTAINER, ...files }, respond: () => ({ code: 0 }) });
}

/** A bare host: no container signals, so sol starts the container itself. */
function onHost(env: Record<string, string> = {}) {
  return createFakeSeams({
    env: { HOME, SOL_NO_UPDATE: "1", ...env },
    cwd: "/work",
    files: packagedRuntime(),
    respond: (argv) => (argv[0] === "docker" && argv[1] === "inspect" ? { code: 1, stderr: "No such object" } : { code: 0 })
  });
}

const execArgv = (seams: FakeSeams) => seams.runner.execCalls[0]?.argv ?? [];
const execEnv = (seams: FakeSeams) => seams.runner.execCalls[0]?.opts.env ?? {};

describe("launch", () => {
  describe("on a host", () => {
    it("should start a container rather than run claude", async () => {
      // Arrange
      const seams = onHost();

      // Act
      await launch({ seams, processArgv: ["node", "sol", "-c"] }).catch(() => undefined);

      // Assert
      expect(seams.runner.execCalls).toEqual([]);
      expect(seams.runner.calls.some((call) => call.argv[0] === "docker" && call.argv[1] === "run")).toBe(true);
      expect(seams.runner.interactiveCalls[0]?.argv.slice(0, 2)).toEqual(["docker", "exec"]);
    });

    it("should take the container path even inside a container under SOL_FORCE_HOST", async () => {
      // Arrange
      const seams = onHost({ SOL_FORCE_HOST: "1", SOL_DRY_RUN: "1" });
      seams.fs.store.set("/.dockerenv", "");

      // Act
      const err = await launch({ seams, processArgv: ["node", "sol"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out[0]).toMatch(/^docker run /);
    });

    it("should report finding nothing under verbosity", async () => {
      // Arrange
      const seams = onHost({ SOL_VERBOSE: "1", SOL_DRY_RUN: "1" });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] }).catch(() => undefined);

      // Assert
      expect(seams.lines.join("")).toContain("no container signals, so sol starts the container itself");
    });
  });

  describe("inside a container", () => {
    it("should do nothing but run claude, with the session-registry hooks", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "sol", "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS}}`, "-c"]);
      expect(seams.runner.calls.filter((call) => call.argv[0] === "docker")).toEqual([]);
    });

    it("should say why under verbosity", async () => {
      // Arrange
      const seams = seamsIn({ SOL_VERBOSE: "1" });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] });

      // Assert
      expect(seams.lines.join("")).toContain("already containerised: /.dockerenv exists");
    });

    it("should accept SOL_FORCE_CONTAINER on a host with no signals", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1", SOL_FORCE_CONTAINER: "1" } });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] });

      // Assert
      expect(execArgv(seams)[0]).toBe("claude");
    });

    it("should hand claude the environment it was given", async () => {
      // Arrange
      const seams = seamsIn({ ANTHROPIC_API_KEY: "sk-ant-mine" });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] });

      // Assert
      expect(execEnv(seams).ANTHROPIC_API_KEY).toBe("sk-ant-mine");
    });
  });

  describe("argument forwarding", () => {
    it.each<[string, string[]]>([
      ["a resume", ["-r", "abc"]],
      ["a prompt after --", ["--", "--settings", "x"]],
      ["skipping permissions, which sol never does by itself", ["--dangerously-skip-permissions"]]
    ])("should forward %s verbatim", async (_name, args) => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "sol", ...args] });

      // Assert
      expect(execArgv(seams).slice(3)).toEqual(args);
    });

    it("should register no hooks for a -p run, which is a script rather than a conversation", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "sol", "-p", "hello"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "-p", "hello"]);
    });
  });

  describe("a user-supplied --settings", () => {
    it("should merge it into the one --settings claude is given", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "sol", "--settings", '{"cleanupPeriodDays":42}', "-c"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS},"cleanupPeriodDays":42}`, "-c"]);
    });

    it("should read a path through the Fs seam, relative to the cwd", async () => {
      // Arrange
      const seams = seamsIn({}, { "/work/mine.json": '{"cleanupPeriodDays":42}' });

      // Act
      await launch({ seams, processArgv: ["node", "sol", "--settings=mine.json"] });

      // Assert
      expect(execArgv(seams)).toEqual(["claude", "--settings", `{${HOOKS},"cleanupPeriodDays":42}`]);
    });

    it.each<[string, string[]]>([
      ["inline json", ["--settings", "{}"]],
      ["a path", ["--settings", "mine.json"]],
      ["the --settings= form", ["--settings={}"]],
      ["the flag twice", ["--settings", "mine.json", "--settings", "{}"]]
    ])("should never let claude see two --settings, given %s", async (_name, userArgs) => {
      // Arrange
      const seams = seamsIn({}, { "/work/mine.json": "{}" });

      // Act
      await launch({ seams, processArgv: ["node", "sol", ...userArgs] });

      // Assert
      expect(execArgv(seams).filter((arg) => arg === "--settings")).toHaveLength(1);
    });

    it("should warn when the user's hooks replace sol's", async () => {
      // Arrange
      const seams = seamsIn();

      // Act
      await launch({ seams, processArgv: ["node", "sol", "--settings", '{"hooks":"nope"}'] });

      // Assert
      expect(seams.lines.join("")).toContain("replaces the session-registry hooks");
    });

    it("should fail naming the value when the file is not there", async () => {
      // Arrange
      const seams = seamsIn();

      // Act / Assert
      await expect(launch({ seams, processArgv: ["node", "sol", "--settings", "missing.json"] })).rejects.toThrow(
        "--settings missing.json cannot be read (looked for /work/missing.json)"
      );
    });
  });

  describe("SOL_DRY_RUN", () => {
    it("should print the invocation and exit 0 without running claude", async () => {
      // Arrange
      const seams = seamsIn({ SOL_DRY_RUN: "1" });

      // Act
      const err = await launch({ seams, processArgv: ["node", "sol", "-c"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.out).toEqual([`claude --settings {${HOOKS}} -c\n`]);
      expect(seams.runner.execCalls).toEqual([]);
    });
  });

  describe("self-update", () => {
    it("should re-exec with SOL_UPDATED=1 after a successful update, with the argv as typed", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME }, files: { ...IN_CONTAINER, ...PUBLISHED }, respond: () => ({ code: 0 }), fetch: NEWER });

      // Act
      await launch({ seams, processArgv: ["node", "sol", "--settings", "mine.json"] });

      // Assert
      expect(execArgv(seams)).toEqual([seams.execPath, seams.scriptPath, "--settings", "mine.json"]);
      expect(execEnv(seams).SOL_UPDATED).toBe("1");
      expect(seams.runner.execCalls).toHaveLength(1);
    });

    it("should carry straight on when there is nothing newer", async () => {
      // Arrange
      const seams = createFakeSeams({
        env: { HOME },
        files: { ...IN_CONTAINER, ...PUBLISHED },
        respond: () => ({ code: 0 }),
        fetch: async () => new Response(JSON.stringify({ "dist-tags": { latest: "0.1.0" } }))
      });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] });

      // Assert
      expect(seams.lines).toEqual([]);
      expect(execArgv(seams)[0]).toBe("claude");
    });

    it("should not update from a working copy, whose version is always behind the feed", async () => {
      // Arrange — no manifest in the fake fs, so the running version reads as 0.0.0.
      const seams = createFakeSeams({ env: { HOME }, files: IN_CONTAINER, respond: () => ({ code: 0 }), fetch: NEWER });

      // Act
      await launch({ seams, processArgv: ["node", "sol"] });

      // Assert
      expect(seams.runner.calls).toEqual([]);
      expect(execArgv(seams)[0]).toBe("claude");
    });

    it("should install nothing under SOL_DRY_RUN=1, even with a newer version on the feed", async () => {
      // Arrange
      const seams = createFakeSeams({ env: { HOME, SOL_DRY_RUN: "1" }, files: { ...IN_CONTAINER, ...PUBLISHED }, respond: () => ({ code: 0 }), fetch: NEWER });

      // Act
      const err = await launch({ seams, processArgv: ["node", "sol"] }).catch((e) => e);

      // Assert
      expect(exitCodeOf(err)).toBe(0);
      expect(seams.runner.calls).toEqual([]);
      expect(seams.runner.execCalls).toEqual([]);
    });
  });
});
