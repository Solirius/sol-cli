/** The public npm registry, read anonymously for the latest published version. */
export const FEED_URL = "https://registry.npmjs.org/";

/** The canonical npm form: the scope separator is encoded so a scoped name stays one path segment. */
export function packumentUrl(feed: string, packageName: string): string {
  const base = feed.endsWith("/") ? feed : `${feed}/`;
  return `${base}${packageName.replace("/", "%2F")}`;
}

/** The whole packument rather than `/latest`, so any npm-compatible registry answers the same shape. */
export function latestFromPackument(body: unknown): string | null {
  const latest = (body as { "dist-tags"?: { latest?: unknown } } | null)?.["dist-tags"]?.latest;
  return typeof latest === "string" && latest !== "" ? latest : null;
}
