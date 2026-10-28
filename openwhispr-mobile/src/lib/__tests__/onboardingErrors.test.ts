import { Sentry } from '@/lib/sentry';
import { OnboardingError, describeOnboardingError } from '../onboardingErrors';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

beforeEach(() => jest.clearAllMocks());

it('shows messages written for users without reporting them', () => {
  const message = describeOnboardingError(
    new OnboardingError('Cloud needs an account.'),
    'Could not save progress.',
  );
  expect(message).toBe('Cloud needs an account.');
  expect(Sentry.captureException).not.toHaveBeenCalled();
});

// Native failures read like "Calling the 'setValueWithKeyAsync' function has failed → OSStatus".
it('reports unexpected failures and shows the fallback instead of their text', () => {
  const error = new Error("Calling the 'setValueWithKeyAsync' function has failed");
  expect(describeOnboardingError(error, 'Could not save progress.')).toBe(
    'Could not save progress.',
  );
  expect(Sentry.captureException).toHaveBeenCalledWith(error);
});
