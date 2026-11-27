import { describe, expect, it } from "vitest";
import { FEED_URL, latestFromPackument, packumentUrl } from "./feed.js";

const FEED_NO_SLASH = FEED_URL.replace(/\/$/, "");

describe("packumentUrl", () => {
  it.each([
    ["a scoped package", FEED_URL, "@solirius-reply/ai-cli", `${FEED_URL}@solirius-reply%2Fai-cli`],
    ["an unscoped package", FEED_URL, "sol-cli", `${FEED_URL}sol-cli`],
    ["a feed with no trailing slash", FEED_NO_SLASH, "@solirius-reply/ai-cli", `${FEED_URL}@solirius-reply%2Fai-cli`]
  ])("should build the packument path for %s", (_name, feed, packageName, expected) => {
    // Act / Assert
    expect(packumentUrl(feed, packageName)).toBe(expected);
  });

  it("should encode the scope separator so the name stays one path segment", () => {
    // Act
    const url = packumentUrl(FEED_URL, "@solirius-reply/ai-cli");

    // Assert
    expect(url).toContain("%2F");
    expect(url.endsWith("@solirius-reply%2Fai-cli")).toBe(true);
  });
});

describe("latestFromPackument", () => {
  it.each([
    ["the latest dist-tag", { "dist-tags": { latest: "1.2.3" } }, "1.2.3"],
    ["no dist-tags at all", { name: "@solirius-reply/ai-cli" }, null],
    ["an empty latest", { "dist-tags": { latest: "" } }, null],
    ["a non-string latest", { "dist-tags": { latest: 3 } }, null],
    ["a body that is not an object", "nope", null],
    ["a null body", null, null]
  ])("should read %s", (_name, body, expected) => {
    // Act / Assert
    expect(latestFromPackument(body)).toBe(expected);
  });
});
