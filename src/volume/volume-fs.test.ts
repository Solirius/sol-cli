import { describe, expect, it } from "vitest";
import { createFakeRunner, type RunResponder } from "../__fixtures__/fake-seams.js";
import { CLAUDE_CONFIG_DIR, createVolumeFs, execTransport, HELPER_IMAGE, helperTransport, parseListing } from "./volume-fs.js";

const TRANSPORT = ["docker", "exec", "-i", "c"];
const FILE = `${CLAUDE_CONFIG_DIR}/sessions.jsonl`;

function volume(respond: RunResponder) {
  const runner = createFakeRunner(respond);
  return { runner, fs: createVolumeFs({ runner }, TRANSPORT) };
}

/** The script and its positional arguments, which is what each call is told apart by. */
function script(argv: string[]): { script: string; args: string[] } {
  return { script: argv[TRANSPORT.length + 2]!, args: argv.slice(TRANSPORT.length + 4) };
}

describe("helperTransport", () => {
  it("should mount the volume where the session containers do", () => {
    // Act / Assert
    expect(helperTransport("sol-claude")).toEqual([
      "docker",
      "run",
      "--rm",
      "-i",
      "--mount",
      `type=volume,source=sol-claude,target=${CLAUDE_CONFIG_DIR}`,
      HELPER_IMAGE
    ]);
  });
});

describe("execTransport", () => {
  it("should exec into the running session as root", () => {
    // Act / Assert
    expect(execTransport("sol-x")).toEqual(["docker", "exec", "-i", "--user", "0", "sol-x"]);
  });
});

describe("createVolumeFs", () => {
  it("should run each operation as sh -c with the path as an argument, never spliced into the script", async () => {
    // Arrange
    const { runner, fs } = volume(() => ({ stdout: "x" }));

    // Act
    await fs.readText("/v/it's");

    // Assert
    expect(runner.calls[0]?.argv).toEqual([...TRANSPORT, "sh", "-c", 'cat -- "$1"', "sh", "/v/it's"]);
  });

  it.each<[string, number, string | null]>([
    ["the contents", 0, "hello\n"],
    ["null for a missing file", 1, null]
  ])("should read %s", async (_name, code, expected) => {
    // Arrange
    const { fs } = volume(() => ({ code, stdout: code === 0 ? "hello\n" : "" }));

    // Act / Assert
    expect(await fs.readText(FILE)).toBe(expected);
  });

  it("should yield lines without the trailing empty one", async () => {
    // Arrange
    const { fs } = volume(() => ({ stdout: "a\nb\n" }));

    // Act
    const lines: string[] = [];
    for await (const line of fs.readLines(FILE)) {
      lines.push(line);
    }

    // Assert
    expect(lines).toEqual(["a", "b"]);
  });

  it("should yield a last line with no newline after it", async () => {
    // Arrange
    const { fs } = volume(() => ({ stdout: "a\nb" }));

    // Act
    const lines: string[] = [];
    for await (const line of fs.readLines(FILE)) {
      lines.push(line);
    }

    // Assert
    expect(lines).toEqual(["a", "b"]);
  });

  it("should yield nothing for a missing file", async () => {
    // Arrange
    const { fs } = volume(() => ({ code: 1 }));

    // Act
    const lines: string[] = [];
    for await (const line of fs.readLines(FILE)) {
      lines.push(line);
    }

    // Assert
    expect(lines).toEqual([]);
  });

  it("should write on stdin, set the mode and hand the file to the volume's owner", async () => {
    // Arrange
    const { runner, fs } = volume(() => ({}));

    // Act
    await fs.writeText(FILE, "content", { mode: 0o600 });

    // Assert
    const { script: body, args } = script(runner.calls[0]!.argv);
    expect(body).toContain('cat > "$1"');
    expect(body).toContain('chmod 600 "$1"');
    expect(body).toContain(`stat -c %u:%g ${CLAUDE_CONFIG_DIR}`);
    expect(args).toEqual([FILE]);
    expect(runner.calls[0]?.opts.stdin).toBe("content");
  });

  it("should append without a mode when none is given", async () => {
    // Arrange
    const { runner, fs } = volume(() => ({}));

    // Act
    await fs.appendText(FILE, "line\n");

    // Assert
    const { script: body } = script(runner.calls[0]!.argv);
    expect(body).toContain('cat >> "$1"');
    expect(body).not.toContain("chmod");
  });

  it.each<[string, () => Promise<unknown>]>([
    ["a write", () => volume(() => ({ code: 1, stderr: "read-only file system\n" })).fs.writeText(FILE, "x")],
    ["an append", () => volume(() => ({ code: 1, stderr: "read-only file system\n" })).fs.appendText(FILE, "x")],
    ["a mkdir", () => volume(() => ({ code: 1, stderr: "read-only file system\n" })).fs.mkdirp(FILE)],
    ["a rename", () => volume(() => ({ code: 1, stderr: "read-only file system\n" })).fs.rename(FILE, `${FILE}.old`)]
  ])("should throw when %s fails", async (_name, act) => {
    // Act / Assert
    await expect(act()).rejects.toThrow(`in the Claude volume: read-only file system`);
  });

  it.each<[string, number, boolean]>([
    ["true when it made the file", 0, true],
    ["false when the file was already there", 3, false]
  ])("should answer createExclusive with %s", async (_name, code, expected) => {
    // Arrange
    const { runner, fs } = volume(() => ({ code }));

    // Act
    const created = await fs.createExclusive(FILE, "claim", { mode: 0o600 });

    // Assert
    expect(created).toBe(expected);
    expect(script(runner.calls[0]!.argv).script).toContain("set -C");
  });

  it("should throw when createExclusive fails for any other reason", async () => {
    // Arrange
    const { fs } = volume(() => ({ code: 1, stderr: "no space left\n" }));

    // Act / Assert
    await expect(fs.createExclusive(FILE, "claim")).rejects.toThrow("could not create");
  });

  it("should create a directory with its mode", async () => {
    // Arrange
    const { runner, fs } = volume(() => ({}));

    // Act
    await fs.mkdirp(`${CLAUDE_CONFIG_DIR}/solr-claims`, { mode: 0o700 });

    // Assert
    expect(script(runner.calls[0]!.argv).script).toContain('mkdir -p "$1" && chmod 700 "$1"');
  });

  it("should rename and remove by path", async () => {
    // Arrange
    const { runner, fs } = volume(() => ({}));

    // Act
    await fs.rename("/a", "/b");
    await fs.remove("/a");

    // Assert
    expect(script(runner.calls[0]!.argv).args).toEqual(["/a", "/b"]);
    expect(script(runner.calls[1]!.argv).script).toBe('rm -rf -- "$1"');
  });

  it.each<[string, "exists" | "isDirectory" | "isWritable", string]>([
    ["exists", "exists", "-e"],
    ["isDirectory", "isDirectory", "-d"],
    ["isWritable", "isWritable", "-w"]
  ])("should answer %s from the test's exit code", async (_name, method, flag) => {
    // Arrange
    const yes = volume(() => ({ code: 0 }));
    const no = volume(() => ({ code: 1 }));

    // Act / Assert
    expect(await yes.fs[method](FILE)).toBe(true);
    expect(await no.fs[method](FILE)).toBe(false);
    expect(script(yes.runner.calls[0]!.argv).script).toBe(`[ ${flag} "$1" ]`);
  });

  it("should list a directory", async () => {
    // Arrange
    const { fs } = volume(() => ({ stdout: "d -home-dev-repo\nf sessions.jsonl\n" }));

    // Act / Assert
    expect(await fs.listDir(CLAUDE_CONFIG_DIR)).toEqual([
      { name: "-home-dev-repo", isDirectory: true },
      { name: "sessions.jsonl", isDirectory: false }
    ]);
  });

  it("should list nothing when the directory cannot be read", async () => {
    // Arrange
    const { fs } = volume(() => ({ code: 1 }));

    // Act / Assert
    expect(await fs.listDir(CLAUDE_CONFIG_DIR)).toEqual([]);
  });
});

describe("parseListing", () => {
  it("should ignore anything that is not a listing line", () => {
    // Act / Assert
    expect(parseListing("Unable to find image 'busybox' locally\nd x\n\nf \n")).toEqual([{ name: "x", isDirectory: true }]);
  });
});
