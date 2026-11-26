import { Platform } from 'react-native';
import {
  keyboardDirectDictationEnabled,
  keyboardDirectDictationSupported,
} from '@/lib/keyboardDirectSetting';
import type { UserConfig } from '@/types';

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { supportsKeyboardDirectDictation: true },
}));

import { AppGroupStorage } from '../../../modules/app-group-storage/src';

const originalOS = Platform.OS;
const originalVersion = Object.getOwnPropertyDescriptor(Platform, 'Version');
function setIOSVersion(version: string): void {
  Object.defineProperty(Platform, 'Version', { configurable: true, value: version });
}

const config = (keyboardDirectDictation?: boolean): UserConfig => ({
  defaultMode: 'cloud',
  keyboardDirectDictation,
});

beforeEach(() => {
  Platform.OS = 'ios';
  setIOSVersion('26.1');
});

afterEach(() => {
  Platform.OS = originalOS;
  AppGroupStorage.supportsKeyboardDirectDictation = true;
  if (originalVersion) Object.defineProperty(Platform, 'Version', originalVersion);
});

describe('keyboardDirectDictationEnabled', () => {
  it('is on for a config that never saved the setting, and before config loads', () => {
    expect(keyboardDirectDictationEnabled(config())).toBe(true);
    expect(keyboardDirectDictationEnabled(null)).toBe(true);
  });

  it('follows a saved choice', () => {
    expect(keyboardDirectDictationEnabled(config(true))).toBe(true);
    expect(keyboardDirectDictationEnabled(config(false))).toBe(false);
  });

  it.each([
    ['iOS 18', () => setIOSVersion('18.7')],
    ['an older native build', () => (AppGroupStorage.supportsKeyboardDirectDictation = false)],
    ['Android', () => (Platform.OS = 'android')],
  ])('is off on %s, even when turned on', (_label, arrange) => {
    arrange();
    expect(keyboardDirectDictationSupported()).toBe(false);
    expect(keyboardDirectDictationEnabled(config(true))).toBe(false);
  });
});
