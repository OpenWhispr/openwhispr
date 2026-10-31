import i18next from 'i18next';
import arabic from '@/locales/ar/translation.json';
import { Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import { useConfigStore } from '@/store/useConfigStore';
import { promptLocalReasoningFallback } from '../localReasoningFallback';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/localReasoning', () => ({
  clearLocalReasoningReadinessCache: jest.fn(),
  getLocalReasoningUnavailableMessage: () => 'Download a local text model.',
}));
const mockUpdateConfig = jest.fn();
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ updateConfig: mockUpdateConfig }) },
}));

it('offers Android models without enabling an Apple setting or silently using cloud', () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const enable = jest.fn();
  const cloud = jest.fn();
  try {
    promptLocalReasoningFallback({
      readiness: { status: 'disabled' },
      signedIn: true,
      onEnableLocal: enable,
      onUseCloudOnce: cloud,
    });
    const buttons = alert.mock.calls[0][2]!;
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Models', 'Use Cloud Once']);
    buttons.find((button) => button.text === 'Models')!.onPress!();
    expect(router.push).toHaveBeenCalledWith('/(account)/ai-models');
    expect(useConfigStore.getState().updateConfig).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
  } finally {
    Platform.OS = original;
    alert.mockRestore();
  }
});

it('localizes the Android fallback while preserving the provider and requiring one-time consent', async () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const cloud = jest.fn();
  const enable = jest.fn();
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'ar', resources: { ar: { translation: arabic.android } } });
  mockUpdateConfig.mockClear();
  try {
    promptLocalReasoningFallback({
      readiness: { status: 'disabled' },
      signedIn: false,
      destinationName: 'Literal provider 123',
      onEnableLocal: enable,
      onUseCloudOnce: cloud,
      copy: (key, fallback, options) => i18n.t(key, { ...options, defaultValue: fallback }),
    });
    const [title, body, buttons] = alert.mock.calls[0];
    expect(title).toBe('الذكاء الاصطناعي المحلي غير متاح');
    expect(body).toContain('Literal provider 123');
    expect(body).not.toContain('Apple');
    expect(buttons!.map(({ text }) => text)).toEqual([
      'إلغاء',
      'النماذج',
      'استخدام Literal provider 123 مرة واحدة',
    ]);
    expect(cloud).not.toHaveBeenCalled();
    buttons![2].onPress!();
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  } finally {
    Platform.OS = original;
    alert.mockRestore();
  }
});
