/** Expand `$VAR` / `${VAR}` API-key fields via the main process. */
import { isEnvRef, usableSecret } from "../helpers/envRef";

export { isEnvRef, usableSecret };

export async function resolveApiKey(value?: string | null): Promise<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (!isEnvRef(raw)) return raw;
  try {
    const resolved = await window.electronAPI?.resolveSecretRef?.(raw);
    // Main distinguishes a stored literal beginning with $ from a reference.
    if (typeof resolved === "string") return resolved;
  } catch {
    // IPC unavailable — never send an unexpanded $VAR to a provider.
  }
  return "";
}
