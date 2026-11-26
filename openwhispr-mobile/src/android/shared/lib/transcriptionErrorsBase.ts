// Turns a raw transcription/upload failure into a short, user-facing message for
// the failed-transcript UI. Already-friendly messages (e.g. "Session expired.",
// "Audio is too large…") pass through untouched; raw platform errors such as
// NSURLErrorDomain dumps or fetch failures are replaced so users never see them.

const OFFLINE_MESSAGE = 'No internet connection. Check your connection and try again.';
const TIMEOUT_MESSAGE = 'The request timed out. Check your connection and try again.';
const UNREADABLE_AUDIO_MESSAGE =
  "Couldn't read this audio file. Please try a WAV, MP3, or M4A file.";
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

export function toFriendlyTranscriptionErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (code === 'AUDIO_TRANSCODE_ERROR' || code === 'AUDIO_CHUNK_ERROR') {
    return UNREADABLE_AUDIO_MESSAGE;
  }

  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  const lower = raw.toLowerCase();

  if (/code=-1001|timed out|timeout/.test(lower)) {
    return TIMEOUT_MESSAGE;
  }
  if (
    /nsurlerrordomain|code=-100[0-9]|code=-120[0-9]/.test(lower) ||
    /internet connection appears to be offline|network connection was lost|could not connect to the server|not connected to the internet|offline/.test(
      lower,
    ) ||
    /network request failed|failed to fetch|load failed|network error/.test(lower)
  ) {
    return OFFLINE_MESSAGE;
  }

  // Anything still leaking a raw platform error or serialized object shouldn't
  // reach the user — fall back to a generic line instead.
  if (!raw || /error domain=|nsurl|exception|[<>{}]/.test(lower)) {
    return GENERIC_MESSAGE;
  }

  return raw;
}
