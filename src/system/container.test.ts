import { describe, expect, it } from "vitest";
import { createFakeFs } from "../__fixtures__/fake-seams.js";
import { type ContainerProbe, containerReasons, isInContainer, probeContainer } from "./container.js";

const NOTHING: ContainerProbe = {
  forcedHost: false,
  forced: false,
  ownMarker: false,
  hasDockerEnv: false,
  hasRemoteContainersEnv: false
};

function probe(overrides: Partial<ContainerProbe>): ContainerProbe {
  return { ...NOTHING, ...overrides };
}

describe("isInContainer", () => {
  it.each<[keyof ContainerProbe]>([
    ["forced"],
    ["ownMarker"],
    ["hasDockerEnv"],
    ["hasRemoteContainersEnv"]
  ])("should treat %s on its own as containerised", (signal) => {
    // Act
    const result = isInContainer(probe({ [signal]: true }));

    // Assert
    expect(result).toBe(true);
  });

  it("should report nothing at all as not containerised", () => {
    // Act / Assert
    expect(isInContainer(NOTHING)).toBe(false);
  });

  it("should let SOL_FORCE_CONTAINER override a probe that found nothing", () => {
    // Act / Assert
    expect(isInContainer(probe({ forced: true }))).toBe(true);
  });

  it.each<[string, Partial<ContainerProbe>]>([
    ["a probe that found a container", { hasDockerEnv: true }],
    ["SOL_FORCE_CONTAINER as well", { hasDockerEnv: true, forced: true }]
  ])("should let SOL_FORCE_HOST override %s, which is how container mode is tested from inside one", (_name, overrides) => {
    // Act / Assert
    expect(isInContainer(probe({ ...overrides, forcedHost: true }))).toBe(false);
  });
});

describe("containerReasons", () => {
  it("should report only the forcing flag when it is set", () => {
    // Act
    const reasons = containerReasons(probe({ forced: true, hasDockerEnv: true }));

    // Assert
    expect(reasons).toEqual(["SOL_FORCE_CONTAINER=1"]);
  });

  it("should list every signal that fired", () => {
    // Act
    const reasons = containerReasons(probe({ hasDockerEnv: true, hasRemoteContainersEnv: true }));

    // Assert
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("/.dockerenv");
    expect(reasons[1]).toContain("REMOTE_CONTAINERS");
  });

  it("should list nothing when no signal fired", () => {
    // Act / Assert
    expect(containerReasons(NOTHING)).toEqual([]);
  });

  it("should report SOL_FORCE_HOST ahead of everything else", () => {
    // Act / Assert
    expect(containerReasons(probe({ forcedHost: true, forced: true, hasDockerEnv: true }))).toEqual(["SOL_FORCE_HOST=1"]);
  });
});

describe("probeContainer", () => {
  it("should find nothing on a bare host", async () => {
    // Act
    const result = await probeContainer({ env: {}, fs: createFakeFs() });

    // Assert
    expect(result).toEqual(NOTHING);
  });

  it("should read the file probe", async () => {
    // Arrange
    const fs = createFakeFs({ "/.dockerenv": "" });

    // Act
    const result = await probeContainer({ env: {}, fs });

    // Assert
    expect(result).toMatchObject({ hasDockerEnv: true });
  });

  it.each([
    ["REMOTE_CONTAINERS"],
    ["REMOTE_CONTAINERS_IPC"],
    ["CODESPACES"],
    ["SOL_IN_CONTAINER"],
    ["SOL_FORCE_CONTAINER"]
  ])("should read %s out of the environment", async (name) => {
    // Act
    const result = await probeContainer({ env: { [name]: "1" }, fs: createFakeFs() });

    // Assert
    expect(isInContainer(result)).toBe(true);
  });

  it("should read SOL_FORCE_HOST out of the environment", async () => {
    // Act
    const result = await probeContainer({ env: { SOL_FORCE_HOST: "1", SOL_IN_CONTAINER: "1" }, fs: createFakeFs() });

    // Assert
    expect(isInContainer(result)).toBe(false);
  });

  it("should ignore an empty REMOTE_CONTAINERS", async () => {
    // Act
    const result = await probeContainer({ env: { REMOTE_CONTAINERS: "" }, fs: createFakeFs() });

    // Assert
    expect(result.hasRemoteContainersEnv).toBe(false);
  });
});
