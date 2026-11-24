/* global jest */
// jest-expo does not implement the native UUID generator. Keep the replacement
// in the test environment so production always requires Expo's secure generator.
jest.mock('expo-crypto', () => ({
  ...jest.requireActual('expo-crypto'),
  randomUUID: jest.requireActual('node:crypto').randomUUID,
}));

// Screens start the speaker model's background download on mount; in tests that would reach
// the (mocked) model store and leave retry timers running past the test. Its own test unmocks it.
jest.mock('@/android/liveSpeakers/speakerModel', () => ({
  prefetchSpeakerModel: jest.fn(async () => undefined),
  RETRY_FIRST_MS: 60_000,
  RETRIES_PER_LAUNCH: 5,
}));

// Jest resolves the default file even when a test changes Platform.OS.
// Select the same copy-hook entry that Metro uses on that platform.
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy() {
    const implementation =
      require('react-native').Platform.OS === 'android'
        ? jest.requireActual('@/hooks/useAndroidCopy.android')
        : jest.requireActual('@/hooks/useAndroidCopy');
    return implementation.useAndroidCopy();
  },
}));
