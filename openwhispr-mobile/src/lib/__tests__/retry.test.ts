import { createApiRetryStrategy } from '../retry';

it('does not retry an error marked final, even without an HTTP status', () => {
  const { shouldRetry } = createApiRetryStrategy();
  expect(shouldRetry?.(Object.assign(new Error('route refused'), { retryable: false }))).toBe(
    false,
  );
  expect(shouldRetry?.(new Error('network down'))).toBe(true);
});
