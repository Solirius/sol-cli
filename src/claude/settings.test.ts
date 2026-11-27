import { describe, expect, it } from "vitest";
import { buildSettings, materialiseSettings } from "./settings.js";

const HOOKS = { SessionEnd: [{ hooks: [{ type: "command", command: "'solr' 'hook' SessionEnd" }] }] };

describe("buildSettings", () => {
  it("should carry the session-registry hooks", () => {
    // Act / Assert
    expect(buildSettings({ hooks: HOOKS })).toEqual({ hooks: HOOKS });
  });

  it("should be empty when there are no hooks to add", () => {
    // Act / Assert
    expect(buildSettings({})).toEqual({});
  });
});

describe("materialiseSettings", () => {
  it("should pass empty settings through as no --settings at all", () => {
    // Act / Assert
    expect(materialiseSettings({})).toBeUndefined();
  });

  it("should inline settings as json", () => {
    // Act / Assert
    expect(materialiseSettings({ hooks: HOOKS })).toBe(JSON.stringify({ hooks: HOOKS }));
  });
});
