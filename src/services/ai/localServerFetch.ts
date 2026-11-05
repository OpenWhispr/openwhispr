import { buildLocalInferenceError } from "../../utils/localInferenceError";
import type { LocalInferenceError } from "../../utils/localInferenceError";

interface LocalServerStartResult {
  error?: string;
  code?: string;
}

export function localServerStartError(result: LocalServerStartResult): LocalInferenceError {
  return buildLocalInferenceError({
    error: result.error || "Failed to start local model server",
    code: result.code,
  });
}

/**
 * Asks main for the server before every request of a local chat turn. The turn's
 * model can be swapped out while a tool runs, and the next server usually reuses
 * the port, so the next step would otherwise be answered by the wrong model.
 */
export function localServerFetch(model: string): typeof fetch {
  return async (input, init) => {
    const server = await window.electronAPI.llamaServerStart(model);
    if (!server.success || !server.port) throw localServerStartError(server);
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.port = String(server.port);
    return fetch(url, init);
  };
}
