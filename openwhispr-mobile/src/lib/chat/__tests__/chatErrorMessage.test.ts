import { LocalReasoningError, UNSUPPORTED_LANGUAGE_MESSAGE } from '@/lib/localReasoning';
import { UPGRADE_REQUIRED_MESSAGE } from '@/lib/policyMessages';
import type { LocalReasoningErrorCode } from '@/types';
import { ChatEmptyAnswerError, ChatNotesReadError, toChatErrorMessage } from '../chatErrorMessage';

const CONNECTION = 'Check your connection and try again.';
const ON_DEVICE = 'On-device AI isn’t available right now.';

const namedError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe('toChatErrorMessage', () => {
  it('reads a timeout or a failed fetch as a connection problem', () => {
    expect(toChatErrorMessage(namedError('AbortError', 'The operation timed out.'))).toBe(
      CONNECTION,
    );
    expect(toChatErrorMessage(namedError('TimeoutError', 'signal timed out'))).toBe(CONNECTION);
    expect(toChatErrorMessage(new TypeError('Network request failed'))).toBe(CONNECTION);
  });

  it('shows the readiness message when on-device AI is unavailable', () => {
    const message = "Apple Intelligence is turned off, so this can't run on-device.";
    expect(
      toChatErrorMessage(new LocalReasoningError('LOCAL_REASONING_UNAVAILABLE', message)),
    ).toBe(message);
  });

  it('falls back to the generic on-device copy when the unavailable error has no message', () => {
    expect(toChatErrorMessage(new LocalReasoningError('LOCAL_REASONING_UNAVAILABLE', ' '))).toBe(
      ON_DEVICE,
    );
  });

  it('keeps the actionable language message for an unsupported language', () => {
    expect(
      toChatErrorMessage(new LocalReasoningError('APPLE_LLM_UNSUPPORTED_LANGUAGE', 'Native text.')),
    ).toBe(UNSUPPORTED_LANGUAGE_MESSAGE);
  });

  // A retry gets the same refusal, so each says what to change rather than that it's unavailable.
  it('asks to rephrase after a guardrail refusal', () => {
    expect(toChatErrorMessage(new LocalReasoningError('APPLE_LLM_GUARDRAIL', 'Raw text.'))).toBe(
      'On-device AI declined to answer this. Try rephrasing your question.',
    );
  });

  it('asks for a narrower question when the answer was too long', () => {
    expect(toChatErrorMessage(new LocalReasoningError('APPLE_LLM_OUTPUT_LIMIT', 'Raw text.'))).toBe(
      'The answer was too long for on-device AI. Try a narrower question.',
    );
  });

  it.each<LocalReasoningErrorCode>([
    'APPLE_LLM_RATE_LIMITED',
    'APPLE_LLM_UNAVAILABLE',
    'APPLE_LLM_FAILED',
    'APPLE_LLM_CANCELLED',
  ])('never calls %s a connection problem', (code) => {
    expect(toChatErrorMessage(new LocalReasoningError(code, 'Raw native text.'))).toBe(ON_DEVICE);
  });

  it.each<LocalReasoningErrorCode>(['LOCAL_CONTEXT_LIMIT', 'APPLE_LLM_CONTEXT_LIMIT'])(
    'suggests a shorter question for %s',
    (code) => {
      const error = new LocalReasoningError(code, 'Context window full.');
      const chatTab =
        'This question needs more context than on-device AI can handle. Try a shorter question or start a new chat.';
      expect(toChatErrorMessage(error)).toBe(chatTab);
      expect(toChatErrorMessage(error, { surface: 'chat' })).toBe(chatTab);
    },
  );

  it('says the note is too long in note chat, which has already cut it', () => {
    expect(
      toChatErrorMessage(
        new LocalReasoningError('APPLE_LLM_CONTEXT_LIMIT', 'Context window full.'),
        {
          surface: 'noteChat',
        },
      ),
    ).toBe('This note is too long for on-device AI.');
    // Only the context limit differs between the surfaces.
    expect(
      toChatErrorMessage(new LocalReasoningError('APPLE_LLM_GUARDRAIL', 'Raw text.'), {
        surface: 'noteChat',
      }),
    ).toBe('On-device AI declined to answer this. Try rephrasing your question.');
  });

  it('says an empty answer came back, never that the connection failed', () => {
    expect(toChatErrorMessage(new ChatEmptyAnswerError())).toBe(
      'The answer came back empty. Try again.',
    );
  });

  it('says the notes couldn’t be read, never that the connection failed', () => {
    expect(toChatErrorMessage(new ChatNotesReadError(new Error('database is locked')))).toBe(
      'Couldn’t read your notes. Try again.',
    );
  });

  it('says what a Cloud error status means, never blaming the connection or showing its text', () => {
    const cases: [number, string][] = [
      [401, 'Your session expired. Sign in again to keep chatting.'],
      [429, 'You’ve reached a usage limit. Try again later.'],
      [500, 'OpenWhispr couldn’t answer right now. Try again.'],
      [503, 'OpenWhispr couldn’t answer right now. Try again.'],
      [403, 'OpenWhispr couldn’t take this question. Try again.'],
      [413, 'OpenWhispr couldn’t take this question. Try again.'],
    ];
    for (const [status, message] of cases) {
      // Shaped as apiClient's ApiError, whose module needs expo's fetch.
      const apiError = Object.assign(new Error('raw server text'), { name: 'ApiError', status });
      expect(toChatErrorMessage(apiError)).toBe(message);
    }
  });

  it('keeps an organization policy message', () => {
    const message = "Your organization's policy doesn't allow OpenWhispr cloud AI.";
    expect(toChatErrorMessage(new Error(message))).toBe(message);
  });

  it('keeps the update-required message', () => {
    expect(toChatErrorMessage(new Error(UPGRADE_REQUIRED_MESSAGE))).toBe(UPGRADE_REQUIRED_MESSAGE);
  });

  it('keeps a route refusal or provider rejection that says what to fix', () => {
    const refusal = Object.assign(new Error('Add your provider credentials in AI Models.'), {
      retryable: false,
    });
    expect(toChatErrorMessage(refusal)).toBe('Add your provider credentials in AI Models.');
  });

  it('keeps the connection message for a retryable provider error', () => {
    const unavailable = Object.assign(new Error('OpenAI is temporarily unavailable.'), {
      retryable: true,
    });
    expect(toChatErrorMessage(unavailable)).toBe(CONNECTION);
  });

  it('keeps on-device errors out of the pass-through', () => {
    expect(
      toChatErrorMessage(new LocalReasoningError('APPLE_LLM_GUARDRAIL', 'raw guardrail text')),
    ).not.toBe('raw guardrail text');
  });

  it('hides raw provider text and anything that is not an error', () => {
    expect(toChatErrorMessage(new Error('HTTP 502: upstream connect error'))).toBe(CONNECTION);
    expect(toChatErrorMessage(new Error(''))).toBe(CONNECTION);
    expect(toChatErrorMessage('boom')).toBe(CONNECTION);
  });
});
