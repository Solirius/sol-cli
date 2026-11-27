import type { Env } from "../system/env.js";

/** The host's Docker socket: the session runs its own engine, so sharing it would put every nested container back on the host. */
export const DROPPED_MOUNT_SOURCES = ["/var/run/docker.sock", "/run/docker.sock"];

/** `--network host` is what makes a nested daemon rewrite the host's docker0 and iptables; sol puts the container on its own bridge. */
export const DROPPED_RUN_ARG_FLAGS = ["--network", "--net"];

export const DEFAULT_CONTAINER_USER = "sol";
export const DEFAULT_CONTAINER_HOME = `/home/${DEFAULT_CONTAINER_USER}`;

/**
 * What a repo with no devcontainer.json of its own gets from the host. Claude's own state is
 * not here: it lives in the shared volume. Each is skipped when the host has no such path.
 */
export const DEFAULT_HOME_BINDS: { path: string }[] = [{ path: ".gitconfig" }, { path: ".ssh" }, { path: ".config/gh" }];

/** Shared by every session, whatever the directory, so a dependency is downloaded once. */
export const DEFAULT_CACHE_VOLUMES: { source: string; path: string }[] = [
  { source: "sol-m2", path: ".m2" },
  { source: "sol-gradle", path: ".gradle" },
  { source: "sol-npm", path: ".npm" },
  { source: "sol-pip", path: ".cache/pip" }
];

/** devcontainer.json properties that change what the container is, which sol does not implement. */
export const UNSUPPORTED_PROPERTIES = [
  "build",
  "dockerFile",
  "dockerfile",
  "dockerComposeFile",
  "features",
  "workspaceMount",
  "workspaceFolder",
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand"
];

export function defaultSpec(vars: SubstitutionVars): DevcontainerSpec {
  const home = vars.env.HOME ?? "";
  return {
    mounts: [
      ...DEFAULT_HOME_BINDS.map((bind) => ({
        kind: "bind" as const,
        source: `${home}/${bind.path}`,
        target: `${DEFAULT_CONTAINER_HOME}/${bind.path}`,
        readonly: true,
        optional: true
      })),
      ...DEFAULT_CACHE_VOLUMES.map((volume) => ({
        kind: "volume" as const,
        source: volume.source,
        target: `${DEFAULT_CONTAINER_HOME}/${volume.path}`,
        readonly: false
      }))
    ],
    runArgs: [],
    containerEnv: {},
    remoteEnv: {},
    forwardPorts: [],
    user: DEFAULT_CONTAINER_USER,
    unsupported: [],
    source: "sol's built-in list"
  };
}

/**
 * devcontainer.json is the authoritative description of the container a repo expects. Null
 * when it is not a JSONC object at all, so the caller can say so and fall back.
 */
export function parseDevcontainer(json: string, vars: SubstitutionVars): DevcontainerSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(json));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const file = parsed as DevcontainerJson;
  const user = stringOr(file.remoteUser) ?? stringOr(file.containerUser);
  const image = stringOr(file.image);
  return {
    ...(image === undefined ? {} : { image: substitute(image, vars) }),
    mounts: parseMounts(Array.isArray(file.mounts) ? file.mounts : [], vars),
    runArgs: filterRunArgs(strings(file.runArgs).map((arg) => substitute(arg, vars))),
    containerEnv: envMap(file.containerEnv, vars),
    remoteEnv: envMap(file.remoteEnv, vars),
    forwardPorts: Array.isArray(file.forwardPorts) ? file.forwardPorts.filter(isPort) : [],
    ...(user === undefined ? {} : { user }),
    unsupported: UNSUPPORTED_PROPERTIES.filter((key) => key in file),
    source: "the repo's .devcontainer/devcontainer.json"
  };
}

/** The spec's mounts as written, plus whatever `SOL_MOUNTS` adds. */
export function resolveMounts(input: { spec: DevcontainerSpec; extra?: string }): Mount[] {
  return [...input.spec.mounts, ...parseExtraMounts(input.extra)];
}

/** `SOL_MOUNTS=/host/path:/container/path[:ro],…` */
export function parseExtraMounts(spec: string | undefined): Mount[] {
  if (spec === undefined || spec === "") {
    return [];
  }
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const parts = entry.split(":");
      const [source, target, flag] = parts;
      if (parts.length < 2 || parts.length > 3 || source === undefined || source === "" || target === undefined || target === "") {
        throw new Error(`SOL_MOUNTS entry "${entry}" is not source:target or source:target:ro`);
      }
      if (flag !== undefined && flag !== "ro") {
        throw new Error(`SOL_MOUNTS entry "${entry}" has a third field that is not "ro"`);
      }
      return { kind: "bind" as const, source, target, readonly: flag === "ro" };
    });
}

export function renderMount(mount: Mount): string {
  const parts = [`type=${mount.kind}`, `source=${mount.source}`, `target=${mount.target}`];
  if (mount.readonly === true) {
    parts.push("readonly");
  }
  return parts.join(",");
}

/**
 * The repo is mounted at its own host path, so the container's workspace folder *is* the
 * local one and both variable families resolve to the same place.
 */
export function substitute(text: string, vars: SubstitutionVars): string {
  const basename = vars.workspaceFolder.split("/").filter(Boolean).at(-1) ?? "";
  return text.replace(/\$\{([^}]+)\}/g, (match, expression: string) => {
    if (expression === "localWorkspaceFolder" || expression === "containerWorkspaceFolder") {
      return vars.workspaceFolder;
    }
    if (expression === "localWorkspaceFolderBasename" || expression === "containerWorkspaceFolderBasename") {
      return basename;
    }
    if (expression.startsWith("localEnv:")) {
      const [name, fallback] = splitOnce(expression.slice("localEnv:".length), ":");
      const value = vars.env[name];
      return value === undefined || value === "" ? (fallback ?? "") : value;
    }
    return match;
  });
}

/**
 * Pairs as well as `=` forms, so `--network host` drops both words and nothing else that
 * happens to read `host`.
 */
export function filterRunArgs(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (DROPPED_RUN_ARG_FLAGS.includes(arg)) {
      index += 1;
      continue;
    }
    if (DROPPED_RUN_ARG_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    kept.push(arg);
  }
  return kept;
}

/** JSONC: line and block comments, and trailing commas, with string contents left alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
    } else if (text[index] === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return text.length;
}

function parseMounts(entries: unknown[], vars: SubstitutionVars): Mount[] {
  const mounts: Mount[] = [];
  for (const entry of entries) {
    const mount = typeof entry === "string" ? parseMountString(substitute(entry, vars)) : parseMountObject(entry, vars);
    if (mount !== null && !DROPPED_MOUNT_SOURCES.includes(mount.source)) {
      mounts.push(mount);
    }
  }
  return mounts;
}

function parseMountString(spec: string): Mount | null {
  const fields = new Map<string, string>();
  let readonly = false;
  for (const field of spec.split(",")) {
    const [key, value] = splitOnce(field, "=");
    if (value === undefined) {
      readonly = readonly || key.trim() === "readonly" || key.trim() === "ro";
    } else {
      fields.set(key.trim(), value.trim());
    }
  }
  const source = fields.get("source") ?? fields.get("src");
  const target = fields.get("target") ?? fields.get("destination") ?? fields.get("dst");
  if (source === undefined || target === undefined) {
    return null;
  }
  const flag = fields.get("readonly") ?? fields.get("ro");
  return { kind: fields.get("type") === "volume" ? "volume" : "bind", source, target, readonly: readonly || flag === "true" || flag === "1" };
}

function parseMountObject(entry: unknown, vars: SubstitutionVars): Mount | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const { type, source, target, readonly } = entry as Record<string, unknown>;
  if (typeof source !== "string" || typeof target !== "string") {
    return null;
  }
  return { kind: type === "volume" ? "volume" : "bind", source: substitute(source, vars), target: substitute(target, vars), readonly: readonly === true };
}

function envMap(value: unknown, vars: SubstitutionVars): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[name] = substitute(raw, vars);
    }
  }
  return out;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + separator.length)];
}

interface DevcontainerJson {
  image?: unknown;
  mounts?: unknown;
  runArgs?: unknown;
  containerEnv?: unknown;
  remoteEnv?: unknown;
  forwardPorts?: unknown;
  containerUser?: unknown;
  remoteUser?: unknown;
}

export interface Mount {
  kind: "bind" | "volume";
  source: string;
  target: string;
  readonly?: boolean;
  /** Left out, rather than created, when the host has nothing at `source`. */
  optional?: boolean;
}

export interface DevcontainerSpec {
  /** Absent for sol's own default image. */
  image?: string;
  mounts: Mount[];
  runArgs: string[];
  /** On `docker run`, so every session in the container sees them. */
  containerEnv: Record<string, string>;
  /** On each session's `docker exec`. */
  remoteEnv: Record<string, string>;
  forwardPorts: number[];
  /** Absent when the image's own user should be used. */
  user?: string;
  /** Properties present in the file that sol ignores, so the launch can say so. */
  unsupported: string[];
  source: string;
}

export interface SubstitutionVars {
  env: Env;
  workspaceFolder: string;
}
