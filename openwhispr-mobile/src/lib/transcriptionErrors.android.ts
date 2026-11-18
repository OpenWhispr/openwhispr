const { toFriendlyTranscriptionErrorMessage: baselineMessage } =
  require('./transcriptionErrors.ts') as typeof import('./transcriptionErrors');

export function toFriendlyTranscriptionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (
    /unable to resolve host|unknownhostexception|no address associated with hostname|failed to connect to/i.test(
      raw,
    )
  ) {
    // Keep the shared formatter's audio-code and timeout precedence.
    const normalized = Object.assign(new Error(`Network error: ${raw}`), {
      code: (error as { code?: string } | null | undefined)?.code,
    });
    return baselineMessage(normalized);
  }
  return baselineMessage(error);
}
