import { matchesHost } from "../../utils/urlUtils";

const OPENCODE_HOST = "opencode.ai";
const SESSION_HEADER = "x-opencode-session";

/**
 * OpenCode Go routes each conversation by a stable `x-opencode-session` id and
 * rejects requests without one (HTTP 400 MissingSessionID). Recognised by host
 * so a custom base such as https://opencode.ai/zen/go/v1 gets the header.
 */
export function isOpenCodeBase(baseUrl: string | null | undefined): boolean {
  return matchesHost(baseUrl, OPENCODE_HOST);
}

/**
 * Session header for one unit of work. Mint it once per call and reuse the
 * result across that call's endpoint fallback, parameter fallback and retries —
 * they are the same conversation. Empty for every other host.
 */
export function openCodeSessionHeaders(baseUrl: string | null | undefined): Record<string, string> {
  return isOpenCodeBase(baseUrl) ? { [SESSION_HEADER]: crypto.randomUUID() } : {};
}
