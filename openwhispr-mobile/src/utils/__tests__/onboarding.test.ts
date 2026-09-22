const mockSecureValues = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(
    (key: string): Promise<string | null> => Promise.resolve(mockSecureValues.get(key) ?? null),
  ),
  setItemAsync: jest.fn((key: string, value: string): Promise<void> => {
    mockSecureValues.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string): Promise<void> => {
    mockSecureValues.delete(key);
    return Promise.resolve();
  }),
}));

import * as SecureStore from 'expo-secure-store';
import { OnboardingService } from '@/utils/onboarding';

beforeEach(() => {
  mockSecureValues.clear();
});

describe('OnboardingService tracking authorization attempt', () => {
  it('survives onboarding completion and an explicit onboarding reset', async () => {
    await OnboardingService.markTrackingAuthorizationRequestAttempted();
    await OnboardingService.completeOnboarding();
    await OnboardingService.resetOnboarding();

    await expect(OnboardingService.hasAttemptedTrackingAuthorizationRequest()).resolves.toBe(true);
  });

  it('assumes a request was attempted when durable storage cannot be read', async () => {
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(OnboardingService.hasAttemptedTrackingAuthorizationRequest()).resolves.toBe(true);
  });
});
