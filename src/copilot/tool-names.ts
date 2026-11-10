/**
 * Tool-name bridging. The gateway only accepts tool names matching
 * [a-zA-Z0-9_-], while VS Code and MCP servers freely use ".", "/" or ":".
 * We sanitize names on the way out and restore the originals on the way
 * back, so the host still recognizes which tool to execute.
 */

const INVALID = /[^a-zA-Z0-9_-]/g;
const MAX_LENGTH = 64;

export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(INVALID, "_");
  return cleaned.length > MAX_LENGTH ? cleaned.slice(0, MAX_LENGTH) : cleaned;
}

/** sanitized → original, collision-resolved with a numeric suffix. */
export function buildToolNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    let key = sanitizeToolName(name);
    if (map.has(key)) {
      let counter = 2;
      const stem = key.slice(0, MAX_LENGTH - 4);
      while (map.has(key)) key = `${stem}-${counter++}`;
    }
    map.set(key, name);
  }
  return map;
}

/** Returns the original name for a gateway-sanitized one (or the input). */
export function restoreToolName(map: ReadonlyMap<string, string>, sanitized: string): string {
  return map.get(sanitized) ?? sanitized;
}
