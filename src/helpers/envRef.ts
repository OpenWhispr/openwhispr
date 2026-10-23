/** Pure `$VAR` helpers for the renderer. Keep in lockstep with `envRef.cjs` (main). */
export const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function isEnvRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ENV_REF_RE.test(value.trim());
}

export function envRefName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(ENV_REF_RE);
  if (!match) return null;
  return match[1] || match[2];
}

/** Never put a leftover `$VAR` on the wire as a credential. */
export function usableSecret(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return !trimmed || isEnvRef(trimmed) ? "" : trimmed;
}

export function classifySecretInput(
  value: unknown,
  selfEnvName?: string | null,
  allowedNames?: Set<string> | null
): "self-reference" | "unknown-ref" | null {
  const name = envRefName(value);
  if (!name) return null;
  if (selfEnvName && name === selfEnvName) return "self-reference";
  if (allowedNames && !allowedNames.has(name)) return "unknown-ref";
  return null;
}
