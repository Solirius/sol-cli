import type { HookSettings } from "./hooks.js";

export function buildSettings(input: { hooks?: HookSettings }): Settings {
  const settings: Settings = {};
  if (input.hooks !== undefined) {
    settings.hooks = input.hooks;
  }
  return settings;
}

/** `--settings` takes JSON inline, which works the same on the host and inside a container. */
export function materialiseSettings(settings: Settings): string | undefined {
  return Object.keys(settings).length === 0 ? undefined : JSON.stringify(settings);
}

/** A user-supplied `--settings` can carry any shape claude accepts. */
export type Settings = Record<string, unknown>;
