import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { containerRunning, pidAlive, pidAliveInContainer } from "./liveness.js";

describe("containerRunning", () => {
  it.each<[string, { code?: number; stdout?: string; stderr?: string }, boolean | null]>([
    ["running", { stdout: "true\n" }, true],
    ["stopped", { stdout: "false\n" }, false],
    ["gone", { code: 1, stderr: "Error: No such object: sol-x" }, false],
    ["unanswerable", { code: 1, stderr: "Cannot connect to the Docker daemon" }, null]
  ])("should answer for a container that is %s", async (_name, result, expected) => {
    // Arrange
    const seams = createFakeSeams({ respond: () => result });

    // Act / Assert
    expect(await containerRunning(seams, "sol-x")).toBe(expected);
  });
});

describe("pidAlive", () => {
  it.each<[string, { code?: number; stdout?: string }, boolean | null]>([
    ["alive", { stdout: "42\n" }, true],
    ["listed with nothing", { stdout: "" }, false],
    ["gone", { code: 1 }, false],
    ["unanswerable", { code: 127 }, null]
  ])("should answer for a pid that is %s", async (_name, result, expected) => {
    // Arrange
    const seams = createFakeSeams({ respond: () => result });

    // Act / Assert
    expect(await pidAlive(seams, 42)).toBe(expected);
  });
});

describe("pidAliveInContainer", () => {
  it.each<[string, { code?: number; stdout?: string }, boolean | null]>([
    ["alive", { stdout: "alive\n" }, true],
    ["dead", { stdout: "dead\n" }, false],
    ["a container that could not be exec'd into", { code: 1, stdout: "" }, null],
    ["an answer it does not recognise", { stdout: "huh" }, null]
  ])("should answer for %s", async (_name, result, expected) => {
    // Arrange
    const seams = createFakeSeams({ respond: () => result });

    // Act / Assert
    expect(await pidAliveInContainer(seams, "sol-x", 42)).toBe(expected);
  });

  it("should ask with the shell's own kill -0, passing the pid as an argument", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: () => ({ stdout: "alive" }) });

    // Act
    await pidAliveInContainer(seams, "sol-x", 42);

    // Assert
    expect(seams.runner.calls[0]?.argv).toEqual([
      "docker",
      "exec",
      "sol-x",
      "sh",
      "-c",
      'if kill -0 "$1" 2>/dev/null; then echo alive; else echo dead; fi',
      "sh",
      "42"
    ]);
  });
});
