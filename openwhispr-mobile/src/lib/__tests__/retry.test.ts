import { LocalReasoningError } from '../localReasoning';
import { createApiRetryStrategy } from '../retry';

it('does not retry an error marked final, even without an HTTP status', () => {
  const { shouldRetry } = createApiRetryStrategy();
  expect(shouldRetry?.(Object.assign(new Error('route refused'), { retryable: false }))).toBe(
    false,
  );
  expect(shouldRetry?.(new Error('network down'))).toBe(true);
});

it('does not retry an On-Device failure, which carries no HTTP status', () => {
  const { shouldRetry } = createApiRetryStrategy();
  expect(shouldRetry?.(new LocalReasoningError('APPLE_LLM_RATE_LIMITED', 'busy'))).toBe(false);
});
