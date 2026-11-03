import i18n from 'i18next';
import { Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import en from '@/locales/en/translation.json';
import ar from '@/locales/ar/translation.json';

const mockUpdateConfig = jest.fn();
const mockSetMode = jest.fn();
const mockSpeechReady = jest.fn();
const mockSpeechAvailable = jest.fn();
const mockTextReadiness = jest.fn();
let mockUser: { id: string; isAnonymous?: boolean } | null = null;
let mockActiveMode = 'cloud';
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => ({ config: null, updateConfig: mockUpdateConfig }) },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: mockActiveMode, setActiveMode: mockSetMode }),
  },
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    preferredEngineDescriptor: () => ({ label: 'Parakeet v2' }),
    isAvailable: () => mockSpeechAvailable(),
    isReadyForLanguage: () => mockSpeechReady(),
  },
}));
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  getLocalReasoningReadiness: () => mockTextReadiness(),
}));

import { showAccountRequiredAlert } from '../accountAccess';
import { switchWorkflowMode } from '../workflowModeSwitch';

const originalOS = Platform.OS;
let alert: jest.SpyInstance;
beforeAll(async () => {
  await i18n.init({ lng: 'ar', fallbackLng: 'en', resources: { en, ar }, defaultNS: 'android' });
});
beforeEach(async () => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  await i18n.changeLanguage('ar');
  mockUser = null;
  mockActiveMode = 'cloud';
  mockSpeechAvailable.mockReturnValue(true);
  mockSpeechReady.mockResolvedValue(true);
  mockTextReadiness.mockResolvedValue({ status: 'modelNotReady' });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});
afterEach(() => {
  Platform.OS = originalOS;
  alert.mockRestore();
});

it('localizes unavailable speech without exposing build instructions or changing the mode', async () => {
  mockSpeechAvailable.mockReturnValue(false);
  await expect(switchWorkflowMode('dictation', 'local')).resolves.toBe('refused');
  expect(alert).toHaveBeenCalledWith(
    'المعالجة على الجهاز غير متاحة',
    'التفريغ الصوتي على الجهاز غير متاح على هذا الجهاز.',
    [{ text: ar.android.done }],
  );
  expect(mockSetMode).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('localizes a failed readiness check and retains the current workflow', async () => {
  mockSpeechReady.mockRejectedValue(new Error('native failure'));
  await expect(switchWorkflowMode('upload', 'local')).resolves.toBe('refused');
  expect(alert).toHaveBeenCalledWith(
    'المعالجة على الجهاز غير متاحة',
    'تعذّر التحقق من النموذج المحلي الآن. حاول مرة أخرى.',
    [{ text: ar.android.done }],
  );
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('uses Android model guidance without Apple settings when a text model is missing', async () => {
  await expect(switchWorkflowMode('cleanup', 'local')).resolves.toBe('refused');
  expect(alert).toHaveBeenCalledWith(
    'المعالجة على الجهاز غير متاحة',
    ar.android.workflowSettings.localModelNeeded,
    [{ text: ar.android.done }],
  );
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockSetMode).not.toHaveBeenCalled();
});

it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
  [true, true, true],
])(
  'keeps account routing and privacy guidance localized (anonymous=%s private=%s cloudOnly=%s)',
  (anonymous, privateMode, cloudOnly) => {
    mockUser = anonymous ? { id: 'anonymous', isAnonymous: true } : null;
    mockActiveMode = privateMode ? 'private' : 'cloud';
    showAccountRequiredAlert('cloud cleanup', { cloudOnly });
    const [title, body, buttons] = alert.mock.calls[0];
    expect(title).toBe(anonymous ? 'إنشاء حساب' : 'يلزم تسجيل الدخول');
    expect(body).toContain('تنقيح النص السحابي');
    expect(body).not.toMatch(/cloud cleanup|Sign in|Create an account|Local Mode/);
    expect(body.includes('أو فعّل')).toBe(!privateMode && !cloudOnly);
    expect(buttons.map(({ text }: { text: string }) => text)).toEqual([
      'إلغاء',
      anonymous ? 'إنشاء حساب' : 'الحساب',
    ]);
    expect(router.push).not.toHaveBeenCalled();
    buttons[1].onPress();
    expect(router.push).toHaveBeenCalledWith(anonymous ? '/auth' : '/(account)');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  },
);

it('reads the current language at alert time while leaving iOS copy unchanged', async () => {
  await i18n.changeLanguage('en');
  showAccountRequiredAlert('AI chat', { cloudOnly: true });
  expect(alert.mock.calls.at(-1)?.[1]).toContain('AI chat');
  await i18n.changeLanguage('ar');
  showAccountRequiredAlert('AI chat', { cloudOnly: true });
  expect(alert.mock.calls.at(-1)?.[1]).toContain('الدردشة بالذكاء الاصطناعي');
  expect(alert.mock.calls.at(-1)?.[1]).not.toContain('AI chat');
  Platform.OS = 'ios';
  showAccountRequiredAlert('AI chat', { cloudOnly: true });
  expect(alert.mock.calls.at(-1)?.slice(0, 2)).toEqual([
    'Sign in required',
    'Sign in to use AI chat. This feature always uses cloud AI, even in Local Mode.',
  ]);
});
