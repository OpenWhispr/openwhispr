import { WordLimitError, wordLimitErrorFromBody } from '../wordLimit';
import { isUsageLimitError } from '@/lib/usageLimitError';

describe('wordLimitErrorFromBody', () => {
  it('uses the server error message when present', () => {
    const error = wordLimitErrorFromBody(
      JSON.stringify({ error: 'Weekly limit of 2000 words reached' }),
    );
    expect(error).toBeInstanceOf(WordLimitError);
    expect(isUsageLimitError(error)).toBe(true);
    expect(error.source).toBe('transcription');
    expect(error.message).toBe('Weekly limit of 2000 words reached');
  });

  it('falls back to the default message when the error field is missing', () => {
    const error = wordLimitErrorFromBody(JSON.stringify({}));
    expect(error.message).toBe('Weekly word limit reached');
  });

  it('falls back to the default message for a non-JSON body', () => {
    const error = wordLimitErrorFromBody('Too Many Requests');
    expect(error.message).toBe('Weekly word limit reached');
  });
});
