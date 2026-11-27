import { describe, expect, it } from "vitest";
import { CLAUDE_CONFIG_DIR } from "../volume/volume-fs.js";
import {
  buildClaudePlatformArgs,
  buildClaudeProbeArgs,
  buildDockerArgs,
  buildHelperInstallArgs,
  buildInstallClaudeArgs,
  buildSessionExecArgs,
  type ContainerContext,
  DEFAULT_IMAGE,
  DOWNLOAD_HELPER_IMAGE,
  ENTRYPOINT,
  INSTALL_CLAUDE,
  RUNTIME_MOUNT_POINT,
  SUPERVISOR,
  TOOLS_MOUNT_POINT
} from "./docker-args.js";

const REPO = "/home/dev/work/repo";

function context(overrides: Partial<ContainerContext> = {}): ContainerContext {
  return {
    image: DEFAULT_IMAGE,
    sessionName: "sol-repo-1234abcd",
    network: "sol",
    platform: "linux",
    repoPath: REPO,
    workdir: `${REPO}/api`,
    containerUser: "sol",
    dockerVolume: "sol-repo-1234abcd-docker",
    claudeVolume: "sol-claude",
    toolsVolume: "sol-tools",
    runtimeDir: "/home/dev/.local/state/sol/runtime",
    publicPorts: false,
    forwardPorts: [],
    mounts: [{ kind: "volume", source: "sol-m2", target: "/home/sol/.m2" }],
    runArgs: [],
    tty: true,
    env: { SOL_IN_CONTAINER: "1", CLAUDE_CONFIG_DIR },
    sessionEnv: {},
    ...overrides
  };
}

describe("buildDockerArgs", () => {
  it("should start a detached, privileged root supervisor on sol's own network", () => {
    // Act
    const argv = buildDockerArgs(context());

    // Assert
    expect(argv.slice(0, 13)).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "sol-repo-1234abcd",
      "--user",
      "0:0",
      "--privileged",
      "--init",
      "--network",
      "sol",
      "--shm-size=2g",
      "--ulimit"
    ]);
    expect(argv.slice(-4)).toEqual(["--entrypoint", "sh", DEFAULT_IMAGE, SUPERVISOR]);
  });

  it("should mount the shared Claude and tools volumes whatever the directory", () => {
    // Act
    const argv = buildDockerArgs(context()).join(" ");

    // Assert
    expect(argv).toContain(`--mount type=volume,source=sol-claude,target=${CLAUDE_CONFIG_DIR}`);
    expect(argv).toContain(`--mount type=volume,source=sol-tools,target=${TOOLS_MOUNT_POINT}`);
    expect(argv).toContain("--mount type=volume,source=sol-repo-1234abcd-docker,target=/var/lib/docker");
  });

  it("should mount the repo at its own path and start in the working directory", () => {
    // Act
    const argv = buildDockerArgs(context()).join(" ");

    // Assert
    expect(argv).toContain(`--mount type=bind,source=${REPO},target=${REPO}`);
    expect(argv).toContain(`-w ${REPO}/api`);
  });

  it("should add the spec's mounts and then the read-only runtime", () => {
    // Act
    const argv = buildDockerArgs(context()).join(" ");

    // Assert
    expect(argv.indexOf("source=sol-m2")).toBeLessThan(argv.indexOf(`target=${RUNTIME_MOUNT_POINT},readonly`));
  });

  it("should pass the environment sorted, then the run args ahead of the image", () => {
    // Act
    const argv = buildDockerArgs(context({ env: { B: "2", A: "1" }, runArgs: ["--cap-add=SYS_PTRACE"] }));

    // Assert
    const tail = argv.slice(argv.indexOf("--env"));
    expect(tail).toEqual(["--env", "A=1", "--env", "B=2", "--cap-add=SYS_PTRACE", "--entrypoint", "sh", DEFAULT_IMAGE, SUPERVISOR]);
  });

  it("should start whatever image the devcontainer named", () => {
    // Act / Assert
    expect(buildDockerArgs(context({ image: "node:22" }))).toContain("node:22");
  });
});

describe("buildSessionExecArgs", () => {
  it("should exec the entrypoint as the session user with a tty", () => {
    // Act / Assert
    expect(buildSessionExecArgs(context(), ["claude", "-c"])).toEqual([
      "docker",
      "exec",
      "-i",
      "-t",
      "--user",
      "sol",
      "-w",
      `${REPO}/api`,
      "sol-repo-1234abcd",
      "sh",
      ENTRYPOINT,
      "claude",
      "-c"
    ]);
  });

  it("should leave out -t with no terminal and carry the session's own environment", () => {
    // Act
    const argv = buildSessionExecArgs(context({ tty: false, sessionEnv: { Z: "1", EDITOR: "vim" } }), ["claude"]);

    // Assert
    expect(argv).not.toContain("-t");
    expect(argv.slice(7, 11)).toEqual(["--env", "EDITOR=vim", "--env", "Z=1"]);
  });
});

describe("buildClaudeProbeArgs", () => {
  it("should run claude through the entrypoint, which puts the tools volume on PATH, so a claude that cannot start counts as missing", () => {
    // Act / Assert
    expect(buildClaudeProbeArgs(context())).toEqual(["docker", "exec", "--user", "sol", "sol-repo-1234abcd", "sh", ENTRYPOINT, "claude", "--version"]);
  });
});

describe("buildInstallClaudeArgs", () => {
  it("should install as root", () => {
    // Act / Assert
    expect(buildInstallClaudeArgs(context())).toEqual(["docker", "exec", "--user", "0", "sol-repo-1234abcd", "sh", INSTALL_CLAUDE]);
  });
});

describe("buildClaudePlatformArgs", () => {
  it("should ask the session container which build it needs", () => {
    // Act / Assert
    expect(buildClaudePlatformArgs(context())).toEqual(["docker", "exec", "sol-repo-1234abcd", "sh", INSTALL_CLAUDE, "--platform"]);
  });
});

describe("buildHelperInstallArgs", () => {
  it("should download in a helper that mounts the same tools volume and the staged runtime", () => {
    // Act / Assert
    expect(buildHelperInstallArgs(context(), "linux-x64")).toEqual([
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=volume,source=sol-tools,target=${TOOLS_MOUNT_POINT}`,
      "--mount",
      `type=bind,source=/home/dev/.local/state/sol/runtime,target=${RUNTIME_MOUNT_POINT},readonly`,
      DOWNLOAD_HELPER_IMAGE,
      "sh",
      INSTALL_CLAUDE,
      "linux-x64"
    ]);
  });
});
