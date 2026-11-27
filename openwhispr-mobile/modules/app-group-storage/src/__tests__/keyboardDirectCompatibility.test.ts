import { AppGroupStorage } from '../index';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo', () => ({
  EventEmitter: class {},
  requireNativeModule: () => ({ getItem: () => 'legacy value' }),
}));

it('leaves the original keyboard handoff usable on native builds predating direct dictation', () => {
  expect(AppGroupStorage.supportsKeyboardDirectDictation).toBe(false);
  expect(AppGroupStorage.setKeyboardSessionCredential(null)).toBe(false);
  expect(AppGroupStorage.getAppGroupContainerPath()).toBeNull();
  expect(AppGroupStorage.wrapPcmAsWav('capture.pcm', 'capture.wav')).toBe(false);
  expect(AppGroupStorage.getItem('legacy')).toBe('legacy value');
});
