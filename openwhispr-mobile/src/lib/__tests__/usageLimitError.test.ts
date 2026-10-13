import { UsageLimitError, isUsageLimitError } from '@/lib/usageLimitError';

describe('UsageLimitError', () => {
  it('preserves quota status and source for 429 handlers', () => {
    const error = new UsageLimitError('Weekly word limit reached', { source: 'transcription' });

    expect(error.status).toBe(429);
    expect(error.source).toBe('transcription');
    expect(isUsageLimitError(error)).toBe(true);
  });

  it('recognizes serialized quota errors from another runtime boundary', () => {
    expect(isUsageLimitError({ name: 'UsageLimitError', status: 429 })).toBe(true);
  });

  it('does not classify generic HTTP errors as quota errors', () => {
    expect(isUsageLimitError({ name: 'TranscriptionApiError', status: 429 })).toBe(false);
  });
});
