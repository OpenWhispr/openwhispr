/** A saved key's first three and last four characters, the way Settings has always shown it. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 3) + "..." + key.slice(-4);
}
