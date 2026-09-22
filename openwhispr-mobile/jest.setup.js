/* global jest */
// jest-expo does not implement the native UUID generator. Keep the replacement
// in the test environment so production always requires Expo's secure generator.
jest.mock('expo-crypto', () => ({
  ...jest.requireActual('expo-crypto'),
  randomUUID: jest.requireActual('node:crypto').randomUUID,
}));
