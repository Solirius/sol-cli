import { describe, expect, it } from "vitest";
import { createFakeSeams, exitCodeOf, type FakeSeams, packagedRuntime } from "../__fixtures__/fake-seams.js";
import { CLAUDE_CONFIG_DIR } from "../volume/volume-fs.js";
import { DEFAULT_IMAGE, DOWNLOAD_HELPER_IMAGE, ENTRYPOINT, INSTALL_CLAUDE, SUPERVISOR } from "./docker-args.js";
import { DOCKER_DESKTOP_SSH_AGENT, runContainerMode, SSH_AGENT_TARGET } from "./run.js";
import { sessionName } from "./session.js";

const HOME = "/home/dev";
const REPO = "/work/repo";
const SESSION = sessionName({ repoPath: REPO });
const REFS = `${HOME}/.local/state/sol/sessions/${SESSION}`;
const DEVCONTAINER = `${REPO}/.devcontainer/devcontainer.json`;

interface Docker {
  /** Whether the session container is already up when this run starts. */
  running?: boolean;
  /** `Config.User` of the image. */
  imageUser?: string;
  hasClaude?: boolean;
  install?: { code: number; stderr?: string };
  /** The helper container's install, for an image that cannot download. */
  helperInstall?: { code: number; stderr?: string };
  run?: { code: number; stderr?: string };
  network?: "present" | "creatable" | "broken";
  ready?: boolean;
  /** pids `ps -p` says are alive. */
  alive?: number[];
}

/** A scripted Docker and the few host commands container mode asks about. */
function responder(docker: Docker) {
  let running = docker.running ?? false;
  return (argv: string[]) => {
    const [bin, sub, ...rest] = argv;
    if (bin === "git" && sub === "rev-parse") {
      return { stdout: `${REPO}\n` };
    }
    if (bin === "git") {
      return { stdout: argv.at(-1) === "user.name" ? "Dev Eloper\n" : "dev@example.com\n" };
    }
    if (bin === "id") {
      return { stdout: sub === "-u" ? "1001\n" : "1002\n" };
    }
    if (bin === "ps") {
      return (docker.alive ?? []).includes(Number(rest[0])) ? { stdout: `${rest[0]}\n` } : { code: 1 };
    }
    if (bin !== "docker") {
      return undefined;
    }
    if (sub === "inspect") {
      return running ? { stdout: "true\n" } : { code: 1, stderr: "Error: No such object" };
    }
    if (sub === "image") {
      return rest.includes("{{.Config.User}}") ? { stdout: `${docker.imageUser ?? ""}\n` } : {};
    }
    if (sub === "network") {
      const network = docker.network ?? "present";
      if (rest[0] === "inspect") {
        return network === "present" ? {} : { code: 1 };
      }
      return network === "creatable" ? {} : { code: 1, stderr: "pool overlaps" };
    }
    if (sub === "run" && argv.includes(SUPERVISOR)) {
      if ((docker.run?.code ?? 0) === 0) {
        running = true;
      }
      return docker.run ?? { stdout: "cid\n" };
    }
    if (sub === "exec" && rest.includes("/run/sol-ready")) {
      return docker.ready === false ? { code: 1 } : {};
    }
    if (sub === "exec" && rest.includes("--version") && rest.includes("claude")) {
      return docker.hasClaude === false ? { code: 1 } : { stdout: "/usr/local/bin/claude\n" };
    }
    if (sub === "exec" && rest.includes(INSTALL_CLAUDE) && rest.includes("--platform")) {
      return { stdout: "linux-x64-musl\n" };
    }
    if (sub === "exec" && rest.includes(INSTALL_CLAUDE)) {
      return docker.install ?? {};
    }
    if (sub === "run" && rest.includes(INSTALL_CLAUDE)) {
      return docker.helperInstall ?? {};
    }
    if (sub === "exec" && rest.includes("-c")) {
      // The volume seam: no .claude.json yet, and every write succeeds.
      return rest.some((arg) => arg.startsWith("cat --")) ? { code: 1 } : {};
    }
    return {};
  };
}

function seamsFor(docker: Docker = {}, over: { env?: Record<string, string>; files?: Record<string, string>; platform?: string } = {}): FakeSeams {
  return createFakeSeams({
    env: { HOME, SOL_NO_PORT_WATCH: "1", ...over.env },
    cwd: `${REPO}/api`,
    platform: over.platform ?? "linux",
    files: { ...packagedRuntime(), ...over.files },
    respond: responder(docker)
  });
}

async function run(seams: FakeSeams, forwarded: string[] = ["-c"]): Promise<number | undefined> {
  return exitCodeOf(await runContainerMode({ seams, forwarded }).catch((e) => e));
}

const dockerCalls = (seams: FakeSeams, sub: string) => seams.runner.calls.filter((call) => call.argv[0] === "docker" && call.argv[1] === sub);
const dockerRun = (seams: FakeSeams) => dockerCalls(seams, "run").find((call) => call.argv.includes(SUPERVISOR))?.argv ?? [];
const sessionExec = (seams: FakeSeams) => seams.runner.interactiveCalls[0]?.argv ?? [];
const removed = (seams: FakeSeams) => dockerCalls(seams, "rm").map((call) => call.argv.at(-1));

describe("runContainerMode", () => {
  describe("a directory with no container yet", () => {
    it("should start one, run claude in it, and remove it on the way out", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      const code = await run(seams);

      // Assert
      expect(code).toBe(0);
      expect(dockerRun(seams)).toContain(DEFAULT_IMAGE);
      const exec = sessionExec(seams);
      expect(exec.slice(exec.indexOf(SESSION), exec.indexOf(SESSION) + 4)).toEqual([SESSION, "sh", ENTRYPOINT, "claude"]);
      expect(exec.at(-1)).toBe("-c");
      expect(removed(seams)).toEqual([SESSION, SESSION]);
      expect(seams.fs.store.has(`${REFS}/4242`)).toBe(false);
    });

    it("should pass claude's exit code through", async () => {
      // Arrange
      const seams = seamsFor();
      seams.runner.interactive = async () => 3;

      // Act / Assert
      expect(await run(seams)).toBe(3);
    });

    it("should pull the image before starting it", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      await run(seams);

      // Assert
      const order = seams.runner.calls.map((call) => call.argv.slice(0, 2).join(" "));
      expect(order.indexOf("docker pull")).toBeLessThan(order.indexOf("docker run"));
    });

    it("should give the container the shared Claude volume and tell claude it is there", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      await run(seams);

      // Assert
      const argv = dockerRun(seams).join(" ");
      expect(argv).toContain(`source=sol-claude,target=${CLAUDE_CONFIG_DIR}`);
      expect(argv).toContain(`--env CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`);
      expect(argv).toContain("--env DISABLE_AUTOUPDATER=1");
      expect(argv).toContain(`--env SOL_CONTAINER_NAME=${SESSION}`);
    });

    it("should use SOL_CLAUDE_VOLUME when it is set", async () => {
      // Arrange
      const seams = seamsFor({}, { env: { SOL_CLAUDE_VOLUME: "work-claude" } });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).join(" ")).toContain("source=work-claude,target=");
    });

    it("should forward the host's git identity and, on Linux, its uid for sol's own user", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      await run(seams);

      // Assert
      const argv = dockerRun(seams);
      expect(argv).toEqual(
        expect.arrayContaining(["SOL_GIT_AUTHOR_NAME=Dev Eloper", "SOL_HOST_UID=1001", "SOL_HOST_GID=1002", "SOL_REMAP_USER=1", "SOL_CONTAINER_USER=sol"])
      );
    });

    it("should not pass the host uid from a Mac, where Docker Desktop maps ownership itself", async () => {
      // Arrange
      const seams = seamsFor({}, { platform: "darwin" });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).join(" ")).not.toContain("SOL_HOST_UID");
    });

    it("should hand every volume to the session user", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).find((arg) => arg.startsWith("SOL_USER_DIRS="))).toBe(
        `SOL_USER_DIRS=${CLAUDE_CONFIG_DIR},/home/sol/.m2,/home/sol/.gradle,/home/sol/.npm,/home/sol/.cache/pip`
      );
    });

    it("should seed .claude.json in the volume so the session opens past onboarding and the trust dialog", async () => {
      // Arrange
      const seams = seamsFor();

      // Act
      await run(seams);

      // Assert
      const write = seams.runner.calls.find((call) => call.opts.stdin?.includes("hasTrustDialogAccepted"));
      expect(write?.argv.slice(0, 6)).toEqual(["docker", "exec", "-i", "--user", "0", SESSION]);
      expect(JSON.parse(write!.opts.stdin!).projects[`${REPO}/api`].hasTrustDialogAccepted).toBe(true);
    });

    it("should wait for the supervisor before the session execs in", async () => {
      // Arrange
      const seams = seamsFor({ ready: false });

      // Act
      await run(seams);

      // Assert
      expect(seams.lines.join("")).toContain(`${SESSION} did not finish starting`);
    });

    it("should bind the host's optional home paths only when they exist", async () => {
      // Arrange
      const seams = seamsFor({}, { files: { [`${HOME}/.gitconfig`]: "[user]\n" } });

      // Act
      await run(seams);

      // Assert
      const argv = dockerRun(seams).join(" ");
      expect(argv).toContain(`source=${HOME}/.gitconfig,target=/home/sol/.gitconfig,readonly`);
      expect(argv).not.toContain(".ssh");
      expect(seams.fs.dirs.has(`${HOME}/.gitconfig`)).toBe(false);
    });

    it("should create a devcontainer's home bind sources first, so Docker does not make directories of them", async () => {
      // Arrange
      const json = JSON.stringify({
        mounts: ["source=${localEnv:HOME}/.kube,target=/root/.kube,type=bind", "source=/home/dev/.bash_history,target=/h,type=bind"]
      });
      const seams = seamsFor({}, { files: { [DEVCONTAINER]: json } });

      // Act
      await run(seams);

      // Assert
      expect(seams.fs.dirs.has(`${HOME}/.kube`)).toBe(true);
      expect(seams.fs.store.get(`${HOME}/.bash_history`)).toBe("");
    });
  });

  describe("a directory whose container is already up", () => {
    it("should join it without pulling or starting anything", async () => {
      // Arrange
      const seams = seamsFor({ running: true, alive: [77] }, { files: { [`${REFS}/77`]: "" } });

      // Act
      await run(seams);

      // Assert
      expect(dockerCalls(seams, "pull")).toEqual([]);
      expect(dockerRun(seams)).toEqual([]);
      expect(sessionExec(seams)).toContain(SESSION);
    });

    it("should leave it running for the other terminal still using it", async () => {
      // Arrange
      const seams = seamsFor({ running: true, alive: [77] }, { files: { [`${REFS}/77`]: "" }, env: { SOL_VERBOSE: "1" } });

      // Act
      await run(seams);

      // Assert
      expect(removed(seams)).toEqual([]);
      expect(seams.lines.join("")).toContain("still in use by another terminal");
    });

    it("should remove it when this is the last terminal out, whoever started it", async () => {
      // Arrange
      const seams = seamsFor({ running: true }, { files: { [`${REFS}/77`]: "" } });

      // Act
      await run(seams);

      // Assert
      expect(removed(seams)).toEqual([SESSION]);
      expect(seams.fs.store.has(`${REFS}/77`)).toBe(false);
    });
  });

  describe("a repo with a devcontainer.json", () => {
    const DEVCONTAINER_JSON = `{
      // JSONC, as VS Code writes it
      "image": "mcr.microsoft.com/devcontainers/javascript-node:22",
      "remoteUser": "node",
      "containerEnv": { "NODE_ENV": "development" },
      "remoteEnv": { "EDITOR": "vim" },
      "runArgs": ["--network=host", "--cap-add=SYS_PTRACE"],
      "postCreateCommand": "npm ci",
    }`;

    it("should start its image as its user, with its environment and run args", async () => {
      // Arrange
      const seams = seamsFor({}, { files: { [DEVCONTAINER]: DEVCONTAINER_JSON } });

      // Act
      await run(seams);

      // Assert
      const argv = dockerRun(seams);
      expect(argv).toContain("mcr.microsoft.com/devcontainers/javascript-node:22");
      expect(argv).toContain("NODE_ENV=development");
      expect(argv).toContain("--cap-add=SYS_PTRACE");
      expect(argv).not.toContain("--network=host");
      expect(argv).not.toContain("SOL_REMAP_USER=1");
      expect(sessionExec(seams)).toEqual(expect.arrayContaining(["--user", "node", "--env", "EDITOR=vim"]));
    });

    it("should say which properties it does not act on", async () => {
      // Arrange
      const seams = seamsFor({}, { files: { [DEVCONTAINER]: DEVCONTAINER_JSON } });

      // Act
      await run(seams);

      // Assert
      expect(seams.lines.join("")).toContain("sets postCreateCommand, which sol does not act on");
    });

    it("should let SOL_IMAGE override the devcontainer's image", async () => {
      // Arrange
      const seams = seamsFor({}, { files: { [DEVCONTAINER]: DEVCONTAINER_JSON }, env: { SOL_IMAGE: "mine:1" } });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams)).toContain("mine:1");
    });

    it("should run as the image's own user when the file names none, and as root when the image names none either", async () => {
      // Arrange
      const withUser = seamsFor({ imageUser: "vscode" }, { files: { [DEVCONTAINER]: '{ "image": "x" }' } });
      const withoutUser = seamsFor({}, { files: { [DEVCONTAINER]: '{ "image": "x" }' } });

      // Act
      await run(withUser);
      await run(withoutUser);

      // Assert
      expect(sessionExec(withUser)).toEqual(expect.arrayContaining(["--user", "vscode"]));
      expect(sessionExec(withoutUser)).toEqual(expect.arrayContaining(["--user", "root"]));
    });

    it("should install claude into the tools volume when the image has none", async () => {
      // Arrange
      const seams = seamsFor({ hasClaude: false }, { files: { [DEVCONTAINER]: '{ "image": "ubuntu:24.04" }' } });

      // Act
      await run(seams);

      // Assert
      expect(seams.lines.join("")).toContain("ubuntu:24.04 has no claude, so it is being installed into the sol-tools volume");
      expect(dockerCalls(seams, "exec").some((call) => call.argv.includes(INSTALL_CLAUDE))).toBe(true);
      expect(sessionExec(seams)).toContain("claude");
    });

    it("should download from a helper container when the image has neither curl nor wget", async () => {
      // Arrange
      const seams = seamsFor({ hasClaude: false, install: { code: 3 } }, { files: { [DEVCONTAINER]: '{ "image": "node:22-slim" }' } });

      // Act
      await run(seams);

      // Assert
      const helper = dockerCalls(seams, "run").find((call) => call.argv.includes(INSTALL_CLAUDE));
      expect(helper?.argv.slice(-4)).toEqual([DOWNLOAD_HELPER_IMAGE, "sh", INSTALL_CLAUDE, "linux-x64-musl"]);
      expect(sessionExec(seams)).toContain("claude");
    });

    it("should fail when the helper cannot download either", async () => {
      // Arrange
      const seams = seamsFor(
        { hasClaude: false, install: { code: 3 }, helperInstall: { code: 1, stderr: "offline" } },
        { files: { [DEVCONTAINER]: '{ "image": "x" }' } }
      );

      // Act / Assert
      await expect(runContainerMode({ seams, forwarded: [] })).rejects.toThrow("could not install claude into x: offline");
    });

    it("should fail with the installer's last words when claude cannot be installed, and still clean up", async () => {
      // Arrange
      const seams = seamsFor(
        { hasClaude: false, install: { code: 1, stderr: "a\nb\nc\nd\ne\nno curl\n" } },
        { files: { [DEVCONTAINER]: '{ "image": "alpine" }' } }
      );

      // Act / Assert
      await expect(runContainerMode({ seams, forwarded: [] })).rejects.toThrow("could not install claude into alpine: b\nc\nd\ne\nno curl");
      expect(removed(seams)).toEqual([SESSION, SESSION]);
    });

    it("should fall back to sol's defaults, saying so, when the file is not a JSON object", async () => {
      // Arrange
      const seams = seamsFor({}, { files: { [DEVCONTAINER]: "[]" } });

      // Act
      await run(seams);

      // Assert
      expect(seams.lines.join("")).toContain("is not a JSON object, so sol's defaults are used instead");
      expect(dockerRun(seams)).toContain(DEFAULT_IMAGE);
    });
  });

  describe("the SSH agent", () => {
    it("should forward the host's agent socket on Linux", async () => {
      // Arrange
      const seams = seamsFor({}, { env: { SSH_AUTH_SOCK: "/run/user/1001/ssh.sock" }, files: { "/run/user/1001/ssh.sock": "" } });

      // Act
      await run(seams);

      // Assert
      const argv = dockerRun(seams).join(" ");
      expect(argv).toContain(`source=/run/user/1001/ssh.sock,target=${SSH_AGENT_TARGET}`);
      expect(argv).toContain(`SSH_AUTH_SOCK=${SSH_AGENT_TARGET}`);
    });

    it("should leave out a socket that is not there", async () => {
      // Arrange
      const seams = seamsFor({}, { env: { SSH_AUTH_SOCK: "/run/user/1001/gone.sock" } });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).join(" ")).not.toContain(SSH_AGENT_TARGET);
    });

    it("should use Docker Desktop's forwarding on a Mac", async () => {
      // Arrange
      const seams = seamsFor({}, { platform: "darwin" });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).join(" ")).toContain(`source=${DOCKER_DESKTOP_SSH_AGENT},target=${SSH_AGENT_TARGET}`);
    });

    it("should forward nothing under SOL_NO_SSH_AGENT", async () => {
      // Arrange
      const seams = seamsFor({}, { platform: "darwin", env: { SOL_NO_SSH_AGENT: "1" } });

      // Act
      await run(seams);

      // Assert
      expect(dockerRun(seams).join(" ")).not.toContain(SSH_AGENT_TARGET);
    });
  });

  describe("the network", () => {
    it("should create sol's network when it is missing", async () => {
      // Arrange
      const seams = seamsFor({ network: "creatable" });

      // Act
      await run(seams);

      // Assert
      expect(dockerCalls(seams, "network").map((call) => call.argv[2])).toEqual(["inspect", "create"]);
    });

    it("should fail, and leave nothing attached, when the network cannot be made", async () => {
      // Arrange
      const seams = seamsFor({ network: "broken" });

      // Act / Assert
      await expect(runContainerMode({ seams, forwarded: [] })).rejects.toThrow("could not create the sol Docker network: pool overlaps");
      expect(seams.fs.store.has(`${REFS}/4242`)).toBe(false);
    });
  });

  it("should fail naming Docker's reason when the container will not start", async () => {
    // Arrange
    const seams = seamsFor({ run: { code: 125, stderr: "port is already allocated" } });

    // Act / Assert
    await expect(runContainerMode({ seams, forwarded: [] })).rejects.toThrow("could not start the sol container: port is already allocated");
  });

  it("should print both argvs under SOL_DRY_RUN and touch nothing", async () => {
    // Arrange
    const seams = seamsFor({}, { env: { SOL_DRY_RUN: "1" } });

    // Act
    const code = await run(seams);

    // Assert
    expect(code).toBe(0);
    expect(seams.out).toHaveLength(2);
    expect(seams.out[0]).toMatch(/^docker run -d --name sol-repo-/);
    expect(seams.out[1]).toMatch(/^docker exec -i/);
    expect(dockerRun(seams)).toEqual([]);
    expect([...seams.fs.store.keys()].filter((path) => path.includes("/sessions/"))).toEqual([]);
  });

  it("should say when the user's own --settings replaces the session-registry hooks", async () => {
    // Arrange
    const seams = seamsFor();

    // Act
    await run(seams, ["--settings", '{"hooks":"nope"}']);

    // Assert
    expect(seams.lines.join("")).toContain("replaces the session-registry hooks");
  });

  it("should refuse to start with no HOME", async () => {
    // Arrange
    const seams = createFakeSeams({ env: {}, respond: responder({}) });

    // Act / Assert
    await expect(runContainerMode({ seams, forwarded: [] })).rejects.toThrow("HOME is not set");
  });

  it("should fall back to the working directory outside a git repo", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, SOL_NO_PORT_WATCH: "1", SOL_DRY_RUN: "1" },
      cwd: "/scratch",
      files: packagedRuntime(),
      respond: (argv) => (argv[0] === "git" ? { code: 128 } : responder({})(argv))
    });

    // Act
    await run(seams);

    // Assert
    expect(seams.out[0]).toContain("source=/scratch,target=/scratch");
    expect(seams.out[0]).toContain(`--name ${sessionName({ repoPath: "/scratch" })}`);
  });
});
