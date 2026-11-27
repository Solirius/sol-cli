import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_VOLUMES,
  DEFAULT_CONTAINER_USER,
  DEFAULT_HOME_BINDS,
  defaultSpec,
  filterRunArgs,
  parseDevcontainer,
  parseExtraMounts,
  renderMount,
  resolveMounts,
  stripJsonc,
  substitute
} from "./mounts.js";

const REPO = "/home/dev/work/my-repo";
const VARS = { env: { HOME: "/home/dev", NPM_TOKEN_FILE: "/home/dev/.npmrc" }, workspaceFolder: REPO };

describe("stripJsonc", () => {
  it.each<[string, string, unknown]>([
    ["a line comment", '{\n  // the image\n  "image": "x"\n}', { image: "x" }],
    ["a trailing line comment", '{ "image": "x" // pinned\n}', { image: "x" }],
    ["a block comment", '{ /* the\n image */ "image": "x" }', { image: "x" }],
    ["a trailing comma in an object", '{ "image": "x", }', { image: "x" }],
    ["a trailing comma in an array", '{ "runArgs": ["--a", ] }', { runArgs: ["--a"] }],
    ["comment markers inside a string", '{ "image": "registry//x/*y*/" }', { image: "registry//x/*y*/" }],
    ["an escaped quote inside a string", '{ "image": "a\\"//b" }', { image: 'a"//b' }],
    ["an unterminated block comment", '{ "image": "x" } /* left open', { image: "x" }]
  ])("should strip %s", (_name, text, expected) => {
    // Act / Assert
    expect(JSON.parse(stripJsonc(text))).toEqual(expected);
  });

  it("should keep an unterminated string rather than loop", () => {
    // Act / Assert
    expect(stripJsonc('"open')).toBe('"open');
  });

  it("should drop a line comment that ends the file", () => {
    // Act / Assert
    expect(stripJsonc("{} // done")).toBe("{} ");
  });
});

describe("substitute", () => {
  it.each<[string, string, string]>([
    ["localWorkspaceFolder", "${localWorkspaceFolder}/.env", `${REPO}/.env`],
    ["containerWorkspaceFolder", "${containerWorkspaceFolder}", REPO],
    ["localWorkspaceFolderBasename", "cache-${localWorkspaceFolderBasename}", "cache-my-repo"],
    ["containerWorkspaceFolderBasename", "${containerWorkspaceFolderBasename}", "my-repo"],
    ["localEnv", "${localEnv:HOME}/.m2", "/home/dev/.m2"],
    ["an unset localEnv", "${localEnv:NOPE}/x", "/x"],
    ["an unset localEnv with a default", "${localEnv:NOPE:/opt}/x", "/opt/x"],
    ["a set localEnv with a default", "${localEnv:HOME:/opt}", "/home/dev"],
    ["a variable sol does not know", "${devcontainerId}", "${devcontainerId}"]
  ])("should resolve %s", (_name, text, expected) => {
    // Act / Assert
    expect(substitute(text, VARS)).toBe(expected);
  });

  it("should give an empty basename for the root", () => {
    // Act / Assert
    expect(substitute("${localWorkspaceFolderBasename}", { env: {}, workspaceFolder: "/" })).toBe("");
  });
});

describe("filterRunArgs", () => {
  it.each<[string, string[], string[]]>([
    ["the separate form", ["--network", "host", "--cap-add", "SYS_PTRACE"], ["--cap-add", "SYS_PTRACE"]],
    ["the = form", ["--network=host", "--init"], ["--init"]],
    ["--net", ["--net", "bridge", "--net=host"], []],
    ["nothing to drop", ["--shm-size=1g"], ["--shm-size=1g"]]
  ])("should drop the network flags in %s", (_name, args, expected) => {
    // Act / Assert
    expect(filterRunArgs(args)).toEqual(expected);
  });
});

describe("parseDevcontainer", () => {
  it("should read every property sol honours", () => {
    // Arrange
    const json = `{
      // a JSONC file, as VS Code writes them
      "image": "mcr.microsoft.com/devcontainers/java:21",
      "mounts": [
        "source=\${localEnv:HOME}/.m2,target=/home/vscode/.m2,type=bind,consistency=cached",
        { "type": "volume", "source": "node-\${localWorkspaceFolderBasename}", "target": "\${containerWorkspaceFolder}/node_modules" },
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"
      ],
      "runArgs": ["--network=host", "--cap-add=SYS_PTRACE"],
      "containerEnv": { "JAVA_OPTS": "-Xmx2g", "WS": "\${containerWorkspaceFolder}", "N": 1 },
      "remoteEnv": { "EDITOR": "vim" },
      "forwardPorts": [8080, "db:5432", 0, 70000, 3000.5, 3000],
      "remoteUser": "vscode",
      "containerUser": "root",
      "postCreateCommand": "npm ci",
    }`;

    // Act
    const spec = parseDevcontainer(json, VARS);

    // Assert
    expect(spec).toEqual({
      image: "mcr.microsoft.com/devcontainers/java:21",
      mounts: [
        { kind: "bind", source: "/home/dev/.m2", target: "/home/vscode/.m2", readonly: false },
        { kind: "volume", source: "node-my-repo", target: `${REPO}/node_modules`, readonly: false }
      ],
      runArgs: ["--cap-add=SYS_PTRACE"],
      containerEnv: { JAVA_OPTS: "-Xmx2g", WS: REPO },
      remoteEnv: { EDITOR: "vim" },
      forwardPorts: [8080, 3000],
      user: "vscode",
      unsupported: ["postCreateCommand"],
      source: "the repo's .devcontainer/devcontainer.json"
    });
  });

  it("should fall back to containerUser when there is no remoteUser", () => {
    // Act / Assert
    expect(parseDevcontainer('{ "containerUser": "node" }', VARS)?.user).toBe("node");
  });

  it("should leave the user and image to the image when the file names neither", () => {
    // Act
    const spec = parseDevcontainer("{}", VARS);

    // Assert
    expect(spec).toEqual({
      mounts: [],
      runArgs: [],
      containerEnv: {},
      remoteEnv: {},
      forwardPorts: [],
      unsupported: [],
      source: "the repo's .devcontainer/devcontainer.json"
    });
  });

  it.each<[string, string]>([
    ["readonly", "type=bind,source=/a,target=/b,readonly"],
    ["ro", "type=bind,source=/a,target=/b,ro"],
    ["readonly=true", "type=bind,source=/a,target=/b,readonly=true"],
    ["ro=1", "type=bind,src=/a,dst=/b,ro=1"]
  ])("should read a read-only mount written as %s", (_name, mount) => {
    // Act / Assert
    expect(parseDevcontainer(JSON.stringify({ mounts: [mount] }), VARS)?.mounts).toEqual([{ kind: "bind", source: "/a", target: "/b", readonly: true }]);
  });

  it("should read a volume written as a string", () => {
    // Act / Assert
    expect(parseDevcontainer(JSON.stringify({ mounts: ["type=volume,source=v,target=/v"] }), VARS)?.mounts).toEqual([
      { kind: "volume", source: "v", target: "/v", readonly: false }
    ]);
  });

  it("should read an object mount marked read-only and the destination spelling", () => {
    // Act
    const spec = parseDevcontainer(JSON.stringify({ mounts: [{ source: "/a", target: "/b", readonly: true }, "source=/c,destination=/d"] }), VARS);

    // Assert
    expect(spec?.mounts).toEqual([
      { kind: "bind", source: "/a", target: "/b", readonly: true },
      { kind: "bind", source: "/c", target: "/d", readonly: false }
    ]);
  });

  it.each<[string, unknown]>([
    ["a string with no target", "source=/a"],
    ["an object with no source", { target: "/b" }],
    ["a number", 42],
    ["null", null]
  ])("should skip %s in mounts", (_name, mount) => {
    // Act / Assert
    expect(parseDevcontainer(JSON.stringify({ mounts: [mount] }), VARS)?.mounts).toEqual([]);
  });

  it.each<[string, string]>([
    ["invalid JSON", "{ nope"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"]
  ])("should answer null for %s", (_name, json) => {
    // Act / Assert
    expect(parseDevcontainer(json, VARS)).toBeNull();
  });

  it("should ignore non-object env maps and a non-array mounts", () => {
    // Act
    const spec = parseDevcontainer(JSON.stringify({ containerEnv: ["A=1"], remoteEnv: "B=2", mounts: "source=/a,target=/b", image: "" }), VARS);

    // Assert
    expect(spec).toMatchObject({ containerEnv: {}, remoteEnv: {}, mounts: [] });
    expect(spec).not.toHaveProperty("image");
  });

  it.each(["build", "dockerComposeFile", "features", "workspaceMount"])("should report %s as something sol does not act on", (key) => {
    // Act / Assert
    expect(parseDevcontainer(JSON.stringify({ [key]: {} }), VARS)?.unsupported).toEqual([key]);
  });
});

describe("defaultSpec", () => {
  it("should bind the host's git and ssh config read-only and share the caches", () => {
    // Act
    const spec = defaultSpec(VARS);

    // Assert
    expect(spec.user).toBe(DEFAULT_CONTAINER_USER);
    expect(spec.image).toBeUndefined();
    expect(spec.mounts).toHaveLength(DEFAULT_HOME_BINDS.length + DEFAULT_CACHE_VOLUMES.length);
    expect(spec.mounts).toContainEqual({ kind: "bind", source: "/home/dev/.gitconfig", target: "/home/sol/.gitconfig", readonly: true, optional: true });
    expect(spec.mounts).toContainEqual({ kind: "volume", source: "sol-m2", target: "/home/sol/.m2", readonly: false });
  });

  it("should never bind Claude's own state from the host", () => {
    // Act / Assert
    expect(
      defaultSpec(VARS)
        .mounts.map((mount) => mount.source)
        .filter((source) => source.includes(".claude"))
    ).toEqual([]);
  });

  it("should leave the home paths empty rather than guess when HOME is unset", () => {
    // Act / Assert
    expect(defaultSpec({ env: {}, workspaceFolder: REPO }).mounts[0]?.source).toBe("/.gitconfig");
  });
});

describe("parseExtraMounts", () => {
  it("should read binds, read-only ones included", () => {
    // Act / Assert
    expect(parseExtraMounts(" /a:/b , /c:/d:ro ,")).toEqual([
      { kind: "bind", source: "/a", target: "/b", readonly: false },
      { kind: "bind", source: "/c", target: "/d", readonly: true }
    ]);
  });

  it.each([undefined, ""])("should add nothing for %j", (spec) => {
    // Act / Assert
    expect(parseExtraMounts(spec)).toEqual([]);
  });

  it.each(["/a", ":/b", "/a:", "/a:/b:/c:/d"])("should refuse %s", (spec) => {
    // Act / Assert
    expect(() => parseExtraMounts(spec)).toThrow("is not source:target");
  });

  it("should refuse a third field that is not ro", () => {
    // Act / Assert
    expect(() => parseExtraMounts("/a:/b:rw")).toThrow('has a third field that is not "ro"');
  });
});

describe("resolveMounts", () => {
  it("should put SOL_MOUNTS after the spec's own", () => {
    // Act
    const mounts = resolveMounts({ spec: { ...defaultSpec(VARS), mounts: [{ kind: "volume", source: "v", target: "/v" }] }, extra: "/a:/b" });

    // Assert
    expect(mounts.map((mount) => mount.target)).toEqual(["/v", "/b"]);
  });
});

describe("renderMount", () => {
  it.each<[string, Parameters<typeof renderMount>[0], string]>([
    ["a bind", { kind: "bind", source: "/a", target: "/b" }, "type=bind,source=/a,target=/b"],
    ["a read-only bind", { kind: "bind", source: "/a", target: "/b", readonly: true }, "type=bind,source=/a,target=/b,readonly"],
    ["a volume", { kind: "volume", source: "v", target: "/v" }, "type=volume,source=v,target=/v"]
  ])("should render %s", (_name, mount, expected) => {
    // Act / Assert
    expect(renderMount(mount)).toBe(expected);
  });
});
