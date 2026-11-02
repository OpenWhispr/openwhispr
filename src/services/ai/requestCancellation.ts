import { httpError } from "../../utils/retry";

// Cancels the renderer's HTTP requests tagged with `ReasoningConfig.requestId`.
// The config crosses IPC on some routes, where an AbortSignal can't be cloned,
// so providers look the signal up here by the id instead.
const controllers = new Map<string, AbortController>();

/** Makes `requestId` cancellable; call the returned release once its requests settle. */
export function trackRequest(requestId: string): () => void {
  const controller = new AbortController();
  controllers.set(requestId, controller);
  return () => {
    if (controllers.get(requestId) === controller) controllers.delete(requestId);
  };
}

export function cancelRequest(requestId: string): void {
  controllers.get(requestId)?.abort();
}

export function requestSignal(requestId: string | undefined): AbortSignal | undefined {
  return requestId ? controllers.get(requestId)?.signal : undefined;
}

export function isRequestCancelled(requestId: string | undefined): boolean {
  return requestSignal(requestId)?.aborted === true;
}

/** Aborts `controller` when the request is cancelled; returns the unlink. */
export function abortOnCancel(
  requestId: string | undefined,
  controller: AbortController
): () => void {
  const signal = requestSignal(requestId);
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

/** Never retried: withRetry gives up on a 4xx other than 408 and 429. */
export const requestCancelledError = (): Error => httpError("Request cancelled", 499);
