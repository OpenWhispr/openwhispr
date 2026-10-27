import { abortError } from './NativeProviderTransport';
import { subscribeProviderCredentialChanges } from './ProviderCredentials';

export interface ProviderCredentialScope {
  signal: AbortSignal;
  assertActive(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  dispose(): void;
}

export function createProviderCredentialScope(
  reference?: string,
  signal?: AbortSignal,
): ProviderCredentialScope {
  const controller = new AbortController();
  // A key change stops the request like a cancel, but the user didn't cancel it.
  let cancelMessage: string | undefined;
  const abort = (): void => controller.abort();
  const unsubscribe = reference
    ? subscribeProviderCredentialChanges((changed): void => {
        if (changed !== null && changed !== reference) return;
        cancelMessage ??= 'Your provider key changed during this request. Retry from history.';
        abort();
      })
    : (): void => undefined;
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const assertActive = (): void => {
    if (controller.signal.aborted) throw abortError(cancelMessage);
  };
  return {
    signal: controller.signal,
    assertActive,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      assertActive();
      let rejectAbort = (): void => undefined;
      try {
        return await new Promise<T>((resolve, reject): void => {
          rejectAbort = (): void => reject(abortError(cancelMessage));
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
          operation().then((value): void => {
            if (controller.signal.aborted) rejectAbort();
            else resolve(value);
          }, reject);
        });
      } finally {
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    },
    dispose(): void {
      unsubscribe();
      signal?.removeEventListener('abort', abort);
    },
  };
}
