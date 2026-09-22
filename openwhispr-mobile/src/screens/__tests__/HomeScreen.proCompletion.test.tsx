import React from 'react';
import { Alert } from 'react-native';
import { render } from '@testing-library/react-native';

let mockRouteParams: { proCompletion?: string } = {};
const mockRouterSetParams = jest.fn();
const mockRegisterSuperwallGate = jest.fn();
const mockUsageStoreState = { usage: null, load: jest.fn() };
const mockProcessingModeStoreState = {
  activeMode: 'cloud',
  setActiveMode: jest.fn(),
};
const mockTranscriptStoreState = {
  transcripts: [],
  deleteTranscript: jest.fn(),
  retryTranscript: jest.fn(),
};
const mockHandoffStoreState = {
  isActive: false,
  isCheckingInitialUrl: false,
  noSpeechDetected: false,
  isTranscribing: false,
};

jest.mock('expo-router', () => ({
  router: {
    setParams: (...args: unknown[]) => mockRouterSetParams(...args),
    push: jest.fn(),
    replace: jest.fn(),
  },
  useLocalSearchParams: () => mockRouteParams,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const transition = { duration: () => ({}) };

  return {
    __esModule: true,
    default: { View },
    FadeInDown: transition,
    FadeOutDown: transition,
    useSharedValue: () => ({ value: 0 }),
    useAnimatedStyle: () => ({}),
    withRepeat: jest.fn(),
    withSequence: jest.fn(),
    withTiming: jest.fn(),
    cancelAnimation: jest.fn(),
  };
});
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    isRecording: false,
    isProcessing: false,
    isSupported: true,
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    cancelRecording: jest.fn(),
    audioRecorder: null,
  }),
}));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: () => ({ currentAmplitude: 0, waveformData: [] }),
}));
jest.mock('@/hooks/useFileUpload', () => ({
  useFileUpload: () => ({ isProcessing: false, pickAndTranscribeFile: jest.fn() }),
}));
jest.mock('@/hooks/useUsageLimitRecovery', () => ({
  useUsageLimitRecovery: () => ({
    handleUsageLimitReached: jest.fn(),
    isRecoveringUsageLimit: false,
  }),
}));
jest.mock('@/hooks/useAppInit', () => ({ useAppInit: jest.fn() }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegisterSuperwallGate }),
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: (selector: (state: typeof mockTranscriptStoreState) => unknown) =>
    selector(mockTranscriptStoreState),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: Object.assign(
    (selector: (state: typeof mockProcessingModeStoreState) => unknown) =>
      selector(mockProcessingModeStoreState),
    { getState: () => mockProcessingModeStoreState },
  ),
}));
jest.mock('@/store/useModelDownloadStore', () => ({
  useModelDownloadStore: (selector: (state: { completedCount: number }) => unknown) =>
    selector({ completedCount: 0 }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: typeof mockUsageStoreState) => unknown) => selector(mockUsageStoreState),
    { getState: () => mockUsageStoreState },
  ),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: { updateConfig: jest.Mock }) => unknown) =>
    selector({ updateConfig: jest.fn() }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: (selector: (state: typeof mockHandoffStoreState) => unknown) =>
    selector(mockHandoffStoreState),
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: { prepareLocal: jest.fn() },
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: jest.fn(() => new Promise(() => {})),
  getPrivateModeUnavailableMessage: jest.fn(),
  promptLocalModelFallback: jest.fn(),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: jest.fn() }));
jest.mock('@/lib/accountAccess', () => ({
  accountRequiredForCloud: jest.fn(),
  cloudModeRequiresAccount: jest.fn(() => false),
  showAccountRequiredAlert: jest.fn(),
}));
jest.mock('@/lib/permissions', () => ({
  isMicPermissionError: jest.fn(() => false),
  isNoSpeechError: jest.fn(() => false),
  showMicPermissionAlert: jest.fn(),
}));
jest.mock('@/lib/utils', () => ({ formatRelativeTime: jest.fn(), safeHaptics: jest.fn() }));
jest.mock('@/config/colors', () => ({ BRAND: '#000000', iosColor: jest.fn(() => '#000000') }));
jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { getItem: jest.fn(), setItem: jest.fn() },
  APP_GROUP_KEYS: {},
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ ProcessingWaveform: () => null }));
jest.mock('@/components/features/TranscriptModal', () => ({ TranscriptModal: () => null }));
jest.mock('@/components/features/RecordingOverlay', () => ({ RecordingOverlay: () => null }));
jest.mock('@/components/features/ParakeetNudgeBanner', () => ({ ParakeetNudgeBanner: () => null }));
jest.mock('@/components/features/KeyboardFullAccessBanner', () => ({
  KeyboardFullAccessBanner: () => null,
}));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/ui/Glass', () => ({ Glass: () => null }));
jest.mock('@/components/ui/CloudIcon', () => ({ CloudIcon: () => null }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/DictationModeControl', () => ({ DictationModeControl: () => null }));
jest.mock('@/components/ui/UsageMeter', () => ({ UsageLimitBanner: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));

import HomeScreen from '../HomeScreen';

describe('HomeScreen Pro completion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteParams = {};
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it.each([
    ['purchased', 'Welcome to OpenWhispr Pro'],
    ['restored', 'OpenWhispr Pro Restored'],
  ] as const)('clears a valid %s completion once without showing it again', (completion, title) => {
    mockRouteParams = { proCompletion: completion };
    const screen = render(<HomeScreen />);

    expect(mockRouterSetParams).toHaveBeenCalledWith({ proCompletion: undefined });
    expect(Alert.alert).toHaveBeenCalledWith(title, expect.any(String), [
      { text: 'Start using Pro' },
    ]);

    mockRouteParams = {};
    screen.rerender(<HomeScreen />);

    expect(mockRouterSetParams).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown completion value', () => {
    mockRouteParams = { proCompletion: 'dismissed' };
    render(<HomeScreen />);

    expect(mockRouterSetParams).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
