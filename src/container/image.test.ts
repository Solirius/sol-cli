import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW } from "../__fixtures__/fake-seams.js";
import { DAILY_MS, imageUser, inspectImageUser, pullImage, shouldPull } from "./image.js";

const HOME = "/home/dev";
const IMAGE = "docker.io/solirius/devcontainer:1";
const PULLS = `${HOME}/.local/state/sol/pulls.json`;

describe("shouldPull", () => {
  it.each<[string, string | undefined, boolean, number | null, boolean]>([
    ["never, even with no image", "never", false, null, false],
    ["always, even with a fresh image", "always", true, FIXED_NOW, true],
    ["missing, with no image", "missing", false, null, true],
    ["missing, with the image", "missing", true, null, false],
    ["the daily default, with no image", undefined, false, null, true],
    ["the daily default, never pulled by sol", undefined, true, null, true],
    ["the daily default, pulled a day ago", "", true, FIXED_NOW - DAILY_MS, true],
    ["daily, pulled an hour ago", "daily", true, FIXED_NOW - 3600_000, false]
  ])("should decide on %s", (_name, policy, present, lastPulledAt, expected) => {
    // Act / Assert
    expect(shouldPull({ policy, present, lastPulledAt, now: FIXED_NOW }).yes).toBe(expected);
  });

  it("should refuse a policy it does not know", () => {
    // Act / Assert
    expect(() => shouldPull({ policy: "sometimes", present: true, lastPulledAt: null, now: FIXED_NOW })).toThrow("SOL_PULL=sometimes");
  });
});

describe("imageUser", () => {
  it.each<[string, string | undefined]>([
    ["vscode\n", "vscode"],
    ["1000:1000", "1000:1000"],
    ["", undefined],
    ["  \n", undefined]
  ])("should read %j", (configUser, expected) => {
    // Act / Assert
    expect(imageUser(configUser)).toBe(expected);
  });
});

describe("inspectImageUser", () => {
  it("should read the image's configured user", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: () => ({ stdout: "node\n" }) });

    // Act / Assert
    expect(await inspectImageUser(seams, IMAGE)).toBe("node");
  });

  it("should know nothing about an image that is not there", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: () => ({ code: 1 }) });

    // Act / Assert
    expect(await inspectImageUser(seams, IMAGE)).toBeUndefined();
  });
});

describe("pullImage", () => {
  it("should pull a missing image, say so, and record when", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => (argv[1] === "image" ? { code: 1 } : {}) });

    // Act
    await pullImage(seams, { image: IMAGE, policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv.slice(0, 2).join(" "))).toEqual(["docker image", "docker pull"]);
    expect(seams.lines.join("")).toContain(`pulling ${IMAGE}`);
    expect(JSON.parse(seams.fs.store.get(PULLS)!)).toEqual({ [IMAGE]: FIXED_NOW });
  });

  it("should not pull an image it checked today", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PULLS]: JSON.stringify({ [IMAGE]: FIXED_NOW - 60_000 }) }, respond: () => ({}) });

    // Act
    await pullImage(seams, { image: IMAGE, policy: undefined });

    // Assert
    expect(seams.runner.calls).toHaveLength(1);
  });

  it("should carry on with the local copy when a refresh fails", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, SOL_VERBOSE: "1" },
      files: { [PULLS]: "not json" },
      respond: (argv) => (argv[1] === "pull" ? { code: 1, stderr: "offline" } : {})
    });

    // Act
    await pullImage(seams, { image: IMAGE, policy: undefined });

    // Assert
    expect(seams.lines.join("")).toContain("the copy on this machine is used: offline");
    expect(seams.fs.store.get(PULLS)).toBe("not json");
  });

  it("should fail when there is no copy to fall back on", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 1, stderr: "manifest unknown" }) });

    // Act / Assert
    await expect(pullImage(seams, { image: IMAGE, policy: "missing" })).rejects.toThrow(`could not pull ${IMAGE}: manifest unknown`);
  });

  it("should treat a pulls file that is not an object as empty", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, files: { [PULLS]: "[1]" }, respond: () => ({}) });

    // Act
    await pullImage(seams, { image: IMAGE, policy: undefined });

    // Assert
    expect(JSON.parse(seams.fs.store.get(PULLS)!)).toEqual({ [IMAGE]: FIXED_NOW });
  });

  it("should not record a pull when there is no state directory", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {}, respond: () => ({}) });

    // Act
    await pullImage(seams, { image: IMAGE, policy: "always" });

    // Assert
    expect(seams.fs.store.size).toBe(0);
  });
});
