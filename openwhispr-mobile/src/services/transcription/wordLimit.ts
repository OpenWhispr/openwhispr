import { UsageLimitError } from '../../lib/usageLimitError';

// Typed error for the cloud transcription 429 (weekly word limit). Lives in
// its own module so UI code and tests can import it without pulling the
// native-module-heavy TranscriptionService.
export class WordLimitError extends UsageLimitError {
  constructor(message: string) {
    super(message, { source: 'transcription' });
    this.name = 'WordLimitError';
  }
}

export function wordLimitErrorFromBody(body: string): WordLimitError {
  let message = 'Weekly word limit reached';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string' && parsed.error) {
      message = parsed.error;
    }
  } catch {
    // Non-JSON 429 body: keep the default message.
  }
  return new WordLimitError(message);
}
