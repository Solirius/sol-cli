import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf } from "./__fixtures__/fake-seams.js";
import { main, solrMain } from "./main.js";

const HOME = "/home/dev";
const KEY = "sk-ant-api03-a-key-that-should-never-be-printed";

describe("main", () => {
  it("should hand over to claude inside a container", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1" }, files: { "/.dockerenv": "" }, respond: () => ({ code: 0 }) });

    // Act
    await main(["node", "sol", "-c"], seams);

    // Assert
    expect(seams.runner.execCalls[0]?.argv[0]).toBe("claude");
    expect(seams.runner.execCalls[0]?.argv.at(-1)).toBe("-c");
    expect(seams.lines).toEqual([]);
  });

  it("should report a failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1", SOL_MOUNTS: "nonsense" }, respond: () => ({ code: 0 }) });

    // Act
    const err = await main(["node", "sol"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain('SOL_MOUNTS entry "nonsense" is not source:target');
  });

  it("should redact a secret that reached an error message", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1" }, files: { "/.dockerenv": "" } });
    seams.runner.exec = async () => {
      throw new Error(`claude rejected ${KEY}`);
    };

    // Act
    await main(["node", "sol"], seams).catch(() => undefined);

    // Assert
    const said = seams.lines.join("");
    expect(said).not.toContain(KEY);
    expect(said).toContain("[redacted]");
  });

  it("should report a solr failure on stderr and exit 1", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1", SOL_MOUNTS: "nonsense" }, files: { "/.dockerenv": "" }, respond: () => ({ code: 0 }) });
    seams.runner.exec = async () => {
      throw new Error("claude is not installed");
    };

    // Act
    const err = await solrMain(["node", "solr"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain("claude is not installed");
  });

  it("should exit 0 from a hook whatever the payload was, a hook never breaking a session", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, stdinText: "not json at all" });

    // Act / Assert
    await expect(solrMain(["node", "solr", "hook", "UserPromptSubmit"], seams)).resolves.toBeUndefined();
  });

  it("should report a thrown non-Error too", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, SOL_NO_UPDATE: "1" }, files: { "/.dockerenv": "" } });
    seams.runner.exec = async () => {
      throw "claude is not installed";
    };

    // Act
    const err = await main(["node", "sol"], seams).catch((e) => e);

    // Assert
    expect(exitCodeOf(err)).toBe(1);
    expect(seams.lines.join("")).toContain("claude is not installed");
  });
});
