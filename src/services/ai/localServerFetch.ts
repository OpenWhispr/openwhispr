import { buildLocalInferenceError } from "../../utils/localInferenceError";
import type { LocalInferenceError } from "../../utils/localInferenceError";

interface LocalServerStartResult {
  error?: string;
  code?: string;
}

function localServerStartError(result: LocalServerStartResult): LocalInferenceError {
  return buildLocalInferenceError({
    error: result.error || "Failed to start local model server",
    code: result.code,
  });
}

/**
 * Asks main for the port serving `model`. Main can wait up to a minute for
 * another model's answer first, so a cancel rejects at once with the signal's
 * reason and tells main to stop waiting rather than swap the model in.
 */
export async function startLocalServer(
  model: string,
  signal?: AbortSignal | null
): Promise<number> {
  signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  let onAbort = (): void => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      void window.electronAPI.llamaServerCancelStart(requestId);
      reject(signal?.reason);
    };
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const server = await Promise.race([
      window.electronAPI.llamaServerStart(model, requestId),
      cancelled,
    ]);
    if (!server.success || !server.port) throw localServerStartError(server);
    return server.port;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Asks main for the server before every request of a local chat turn. The turn's
 * model can be swapped out while a tool runs, and the next server usually reuses
 * the port, so the next step would otherwise be answered by the wrong model.
 */
export function localServerFetch(model: string): typeof fetch {
  return async (input, init) => {
    const port = await startLocalServer(model, init?.signal);
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.port = String(port);
    return fetch(url, init);
  };
}
