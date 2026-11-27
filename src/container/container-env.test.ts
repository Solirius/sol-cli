import { describe, expect, it } from "vitest";
import { PASSTHROUGH, passthroughEnv } from "./container-env.js";

describe("passthroughEnv", () => {
  it("should carry over only the names on the list, and only when set", () => {
    // Act
    const env = passthroughEnv({ SOL_VERBOSE: "1", TERM: "xterm-256color", SOL_OFFLINE: "", AWS_SECRET_ACCESS_KEY: "nope", PATH: "/usr/bin" });

    // Assert
    expect(env).toEqual({ SOL_VERBOSE: "1", TERM: "xterm-256color" });
  });

  it("should carry no credential-bearing name", () => {
    // Act / Assert
    expect(PASSTHROUGH.filter((name) => /TOKEN|KEY|SECRET|PASSWORD/i.test(name))).toEqual([]);
  });
});
