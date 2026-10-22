// Whitespace, letter case and recipient order don't make a send a new one.
function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().toLowerCase();
  if (Array.isArray(value)) return value.map(normalize).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, normalize((value as Record<string, unknown>)[name])])
    );
  }
  return value;
}

// cyrb53: a fast 53-bit string hash. Synchronous, so a tool still claims its
// turn slots before its first await.
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * One key per send: the connector, the action, where it goes and what it
 * says. A conversation never repeats a send whose key it already recorded.
 */
export function connectorActionKey(
  connectorId: string,
  action: string,
  args: Record<string, unknown>
): string {
  return `${connectorId}.${action}:${hash53(JSON.stringify(normalize(args)))}`;
}
