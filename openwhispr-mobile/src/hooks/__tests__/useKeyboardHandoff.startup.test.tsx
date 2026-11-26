jest.mock('../../../modules/background-uploader/src', () => ({
  BackgroundUploader: { clearProviderRecovery: () => false },
}));
import { Linking } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

type RecordingStoppedEvent = {
  fileUri: string;
  fileName: string;
  mimeType: string;
  recordingFormat: string;
  jobId: string;
  fileSizeBytes: number;
  recordingDurationMs: number;
};

const mockHandoffStoreState = {
  isActive: false,
  setActive: jest.fn(),
  setCheckingInitialUrl: jest.fn(),
  setNoSpeechDetected: jest.fn(),
  setTranscribing: jest.fn(),
  setReturnState: jest.fn(),
  reset: jest.fn(),
};
const mockSubscription = { remove: jest.fn() };
const mockMarkRecoveryDeepLink = jest.fn();
const mockAddTranscript = jest.fn();
const mockAddFailedTranscript = jest.fn();
const mockCleanupTranscript = jest.fn();
const mockTranscribeAndCleanup = jest.fn();
const mockTranscribe = jest.fn();
const mockRetainTranscriptAudio = jest.fn();
const mockAnalyzeSpeechActivity = jest.fn();
let mockRecordingStoppedListener: ((event: RecordingStoppedEvent) => Promise<void>) | undefined;
let mockBackgroundStartedListener: (() => void) | undefined;

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: jest.fn(() => null),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    setKeyboardStatus: jest.fn(),
    markKeyboardTiming: jest.fn(),
    endProcessingTask: jest.fn(),
    startNativeRecording: jest.fn(() => true),
    returnToPreviousApp: jest.fn(),
    stopNativeRecording: jest.fn(),
    markHotkeyJsReady: jest.fn(),
  },
  APP_GROUP_KEYS: {
    KEYBOARD_RECORDING_JOB_ID: 'keyboard_recording_job_id',
    KEYBOARD_RECORDING_FORMAT: 'keyboard_recording_format',
    KEYBOARD_HANDOFF_INTENT_AT_MS: 'keyboard_handoff_intent_at_ms',
    KEYBOARD_PENDING_TRANSCRIPT: 'keyboard_pending_transcript',
    KEYBOARD_PENDING_TRANSCRIPT_JOB_ID: 'keyboard_pending_transcript_job_id',
    KEYBOARD_ORPHANED_RAW_TRANSCRIPT: 'keyboard_orphaned_raw_transcript',
    KEYBOARD_ORPHANED_RAW_TRANSCRIPT_JOB_ID: 'keyboard_orphaned_raw_transcript_job_id',
    KEYBOARD_TRANSCRIPTION_ERROR: 'keyboard_transcription_error',
    KEYBOARD_CANCEL_REQUESTED: 'keyboard_cancel_requested',
    KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED: 'keyboard_compressed_audio_unsupported',
    KEYBOARD_COMPRESSED_AUDIO_UNSUPPORTED_AT_MS: 'keyboard_compressed_audio_unsupported_at_ms',
    HOTKEY_JS_READY_AT_MS: 'hotkey_js_ready_at_ms',
  },
  addRecordingStoppedListener: (listener: (event: RecordingStoppedEvent) => Promise<void>) => {
    mockRecordingStoppedListener = listener;
    return mockSubscription;
  },
  addRecordingErrorListener: () => mockSubscription,
  addBackgroundRecordingStartedListener: (listener: () => void) => {
    mockBackgroundStartedListener = listener;
    return mockSubscription;
  },
  addKeyboardStatusChangedListener: () => mockSubscription,
  addAgentActionListener: () => mockSubscription,
}));
jest.mock('../../../modules/live-activity/src', () => ({
  LiveActivity: { setDictationMode: jest.fn(), startSession: jest.fn() },
}));
jest.mock('@/store/useHandoffStore', () => ({
  useHandoffStore: { getState: () => mockHandoffStoreState },
}));
jest.mock('@/store/useKeyboardRecoveryStore', () => ({
  consumeRecoveryDeepLink: () => false,
  useKeyboardRecoveryStore: {
    getState: () => ({ markRecoveryDeepLink: mockMarkRecoveryDeepLink }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ activeMode: 'cloud' }) },
}));
jest.mock('@/store/useTranscriptStore', () => ({
  useTranscriptStore: {
    getState: () => ({
      addTranscript: mockAddTranscript,
      addFailedTranscript: mockAddFailedTranscript,
      transcripts: [],
      load: jest.fn(),
    }),
  },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: jest.requireActual('zustand').create(() => ({
    isInitialized: false,
    user: null,
    sessionCookie: null,
    isGuest: false,
    initialize: () => mockInitialize(),
  })),
}));
jest.mock('@/store/useSnippetsStore', () => ({
  useSnippetsStore: { getState: () => ({ snippets: [] }) },
}));
jest.mock('@/services/transcription/TranscriptionService', () => ({
  TranscriptionService: {
    prepareLocal: jest.fn(() => Promise.resolve()),
    transcribe: (...args: unknown[]) => mockTranscribe(...args),
  },
  isLocalModelMissingError: () => false,
}));
jest.mock('@/services/agent/AgentComposerService', () => ({
  generateForJob: jest.fn(),
  handleAgentAction: jest.fn(),
}));
jest.mock('@/lib/cleanupTranscript', () => ({
  cleanupTranscript: (...args: unknown[]) => mockCleanupTranscript(...args),
}));
jest.mock('@/lib/transcribeAndCleanup', () => ({
  transcribeAndCleanup: (...args: unknown[]) => mockTranscribeAndCleanup(...args),
}));
jest.mock('@/lib/keyboardToneSync', () => ({
  startKeyboardToneSync: () => () => undefined,
  snapshotKeyboardTone: jest.fn(),
  readKeyboardToneSnapshot: jest.fn(() => null),
}));
jest.mock('@/lib/keyboardAgentSync', () => ({
  startKeyboardAgentSync: () => () => undefined,
  snapshotKeyboardAgentRequest: jest.fn(() => null),
  readKeyboardAgentJob: jest.fn(() => null),
  clearKeyboardAgentJob: jest.fn(),
  consumeKeyboardAgentAction: jest.fn(() => null),
}));
jest.mock('@/lib/snippets', () => ({ expandSnippets: (text: string) => text }));
jest.mock('@/lib/speechActivity', () => ({
  analyzeSpeechActivity: (...args: unknown[]) => mockAnalyzeSpeechActivity(...args),
  serializeSpeechActivityMetrics: jest.fn(),
}));
jest.mock('@/lib/transcriptionLanguage', () => ({
  getPreferredTranscriptionLanguage: () => 'en',
}));
jest.mock('@/lib/transcriptionErrors', () => ({
  toFriendlyTranscriptionErrorMessage: (error: unknown) => String(error),
}));
jest.mock('@/lib/transcriptAudio', () => ({
  deleteManagedTranscriptAudio: jest.fn(async () => undefined),
  retainTranscriptAudio: (...args: unknown[]) => mockRetainTranscriptAudio(...args),
}));
jest.mock('@/lib/permissions', () => ({ isNoSpeechError: () => false }));
jest.mock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string): Promise<string> =>
    jest.requireActual('node:crypto').createHash('sha256').update(value).digest('hex'),
  randomUUID: jest.requireActual('node:crypto').randomUUID,
}));

import { AppGroupStorage } from '../../../modules/app-group-storage/src';
const storage = AppGroupStorage as unknown as {
  getItem: jest.Mock;
  setItem: jest.Mock;
  removeItem: jest.Mock;
  setKeyboardStatus: jest.Mock;
  startNativeRecording: jest.Mock;
  stopNativeRecording: jest.Mock;
  returnToPreviousApp: jest.Mock;
  markHotkeyJsReady: jest.Mock;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: jest.requireActual('zustand').create(() => ({
    config: null,
    isLoading: true,
    loadConfig: () => mockLoadConfig(),
  })),
}));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: jest.requireActual('zustand').create(() => ({
    hydrated: false,
    finished: false,
    hydrate: () => mockHydrate(),
  })),
}));
jest.mock('@/lib/authClient', () => ({ getCachedSession: () => mockReadCachedSession() }));
jest.mock('@/lib/apiClient', () => ({
  BASE_URL: 'https://test.invalid',
  getClientVersionHeader: () => ({}),
}));
const mockQueueStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockQueueStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockQueueStorage.set(key, value);
    },
  },
}));
interface Batch {
  expected_user_id: string;
  events: { event_id: string; event_name: string; properties: Record<string, unknown> }[];
}
const mockRequests: Batch[] = [];
jest.mock('expo/fetch', () => ({
  fetch: async (url: string, options: { body: string }) => {
    const body = JSON.parse(options.body) as Batch;
    if (url.endsWith('/batch')) mockRequests.push(body);
    return {
      status: 200,
      json: async () =>
        url.endsWith('/app-session')
          ? {
              binding_id: '0d6b9a52-7a3c-4c8e-9f1d-2b4a6c8e0f13',
              authenticated_at: new Date().toISOString(),
            }
          : { accepted: body.events.map((event) => event.event_id) },
    };
  },
}));

// Render the real root initialization and keyboard hook; UI and unrelated startup services are inert.
jest.mock('../../../global.css', () => ({}));
jest.mock('react-native-css-interop', () => ({
  createInteropElement: jest.requireActual('react').createElement,
}));
jest.mock('@react-navigation/native', () => ({}));
jest.mock('expo-router', () => ({ useSegments: () => [], router: { replace: jest.fn() } }));
jest.mock('expo-font', () => ({ useFonts: () => [false] }));
jest.mock('@expo-google-fonts/space-grotesk', () => ({}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/superwall/OpenWhisprSuperwallProvider', () => ({
  OpenWhisprSuperwallProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/features/AnimatedSplash', () => ({ AnimatedSplash: () => null }));
jest.mock('@/components/ui/PermissionAlert', () => ({ PermissionAlertMount: () => null }));
jest.mock('@/screens/AuthScreen', () => () => null);
jest.mock('@/screens/onboarding/OnboardingFlow', () => ({ OnboardingFlow: () => null }));
jest.mock('@/hooks/useRevenueCatIdentity', () => ({ useRevenueCatIdentity: () => undefined }));
jest.mock('@/hooks/useAffiliateAttribution', () => ({ useAffiliateAttribution: () => undefined }));
jest.mock('@/hooks/useAnonymousOnboardingSession', () => ({
  useAnonymousOnboardingSession: () => undefined,
}));
jest.mock('@/hooks/useGuestPrivateMode', () => ({ useGuestPrivateMode: () => undefined }));
jest.mock('@/store/useCustomPromptsStore', () => ({ startRetiredPromptSweep: () => undefined }));
jest.mock('@/store/useUsageStore', () => ({ useUsageStore: { getState: () => ({}) } }));
jest.mock('@/lib/appResume', () => ({ resolveResumeAction: () => ({}) }));
jest.mock('@/lib/navigateHome', () => ({ navigateHome: () => undefined }));
jest.mock('@/db/migrate', () => ({ runMigrations: () => undefined }));
jest.mock('@/lib/sentry', () => ({
  initSentry: () => undefined,
  Sentry: { wrap: (component: unknown) => component },
}));
jest.mock('@/lib/appsflyer', () => ({ initAppsFlyer: () => undefined }));
jest.mock('@/sync/syncEngine', () => ({ initSyncTriggers: () => undefined }));
jest.mock('@/lib/keyboardFullAccessProbe', () => ({
  startKeyboardFullAccessProbe: () => () => undefined,
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  eraseProviderCredentialsFromPreviousInstall: async () => undefined,
}));

import RootLayout from '../../../app/_layout';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import type { AuthUser } from '@/lib/authClient';

const ACCOUNT: AuthUser = {
  id: 'restored-account',
  email: 'person@example.com',
  emailVerified: true,
  isAnonymous: false,
};
let mockCachedSession: { user: AuthUser; sessionCookie: string } | null;
const mockReadCachedSession = jest.fn(async () => mockCachedSession);
let configReady: ReturnType<typeof deferred<void>>;
let onboardingReady: ReturnType<typeof deferred<void>>;
let authReady: ReturnType<typeof deferred<void>>;
const mockInitialize = jest.fn(() => authReady.promise);
const mockLoadConfig = jest.fn(() => configReady.promise);
const mockHydrate = jest.fn(() => onboardingReady.promise);
let items: Map<string, string>;

function dictations(): Batch['events'] {
  return mockRequests
    .flatMap((batch) => batch.events)
    .filter((event) => event.event_name === 'dictation_completed');
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function restoreLocal(enabled = true): Promise<void> {
  await act(async () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: enabled },
      isLoading: false,
    });
    configReady.resolve();
    useOnboardingStore.setState({ hydrated: true, finished: true });
    onboardingReady.resolve();
  });
}
async function restoreAccount(user: AuthUser | null = ACCOUNT): Promise<void> {
  await act(async () => {
    useAuthStore.setState({
      isInitialized: true,
      user,
      sessionCookie: user ? `cookie-${user.id}` : null,
    });
    authReady.resolve();
  });
}
async function stopRecording(): Promise<void> {
  const jobId = items.get('keyboard_recording_job_id')!;
  await act(async () => {
    await mockRecordingStoppedListener!({
      fileUri: 'file:///tmp/audio.wav',
      fileName: 'audio.wav',
      mimeType: 'audio/wav',
      recordingFormat: 'wav',
      jobId,
      fileSizeBytes: 100,
      recordingDurationMs: 1000,
    });
  });
  expect(items.get('keyboard_pending_transcript')).toBe('clean transcript');
  await settle();
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockReadCachedSession.mockImplementation(async () => mockCachedSession);
  configReady = deferred<void>();
  onboardingReady = deferred<void>();
  authReady = deferred<void>();
  mockCachedSession = { user: ACCOUNT, sessionCookie: 'cookie-restored-account' };
  useAuthStore.setState({ isInitialized: false, user: null, sessionCookie: null, isGuest: false });
  useConfigStore.setState({ config: null, isLoading: true });
  useOnboardingStore.setState({ hydrated: false, finished: false });
  await settle();
  mockRequests.length = 0;
  items = new Map();
  storage.getItem.mockImplementation((key: string) => items.get(key) ?? null);
  storage.setItem.mockImplementation((key: string, value: string) => {
    items.set(key, value);
    return true;
  });
  storage.removeItem.mockImplementation((key: string) => items.delete(key));
  storage.startNativeRecording.mockReturnValue(true);
  storage.markHotkeyJsReady.mockReset();
  storage.returnToPreviousApp.mockResolvedValue({ status: 'opened', hostName: 'Slack' });
  mockAddTranscript.mockResolvedValue(undefined);
  mockCleanupTranscript.mockResolvedValue('clean transcript');
  mockTranscribeAndCleanup.mockResolvedValue({
    text: 'clean transcript',
    originalText: 'raw transcript',
    transcription: { text: 'raw transcript', duration: 1, provider: 'cloud' },
  });
  mockRetainTranscriptAudio.mockResolvedValue('file://retained.m4a');
  mockAnalyzeSpeechActivity.mockResolvedValue(null);
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue('openwhispr://keyboard-dictation');
});
afterEach(() => jest.restoreAllMocks());

it('restores local startup before cold capture without waiting for account network restoration', async () => {
  render(<RootLayout />);
  await settle();
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
  expect(storage.markHotkeyJsReady).not.toHaveBeenCalled();
  await restoreLocal();
  expect(useAuthStore.getState().isInitialized).toBe(false);
  expect(storage.startNativeRecording).toHaveBeenCalledTimes(1);
  expect(storage.markHotkeyJsReady).toHaveBeenCalledTimes(1);
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toEqual([
    expect.objectContaining({
      properties: expect.objectContaining({ word_count: 2, is_practice: false }),
    }),
  ]);
});

it('makes native hotkey starts ready after local hydration and captures their original cached owner', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  render(<RootLayout />);
  await settle();
  expect(storage.markHotkeyJsReady).not.toHaveBeenCalled();
  await restoreLocal();
  expect(storage.markHotkeyJsReady).toHaveBeenCalledTimes(1);
  items.set('keyboard_recording_job_id', `${Date.now()}-hotkey`);
  act(() => mockBackgroundStartedListener!());
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toHaveLength(1);
});

it.each(['guest', 'anonymous', 'opt-out', 'signed-out'] as const)(
  'still delivers %s dictation without attributing it to a later login',
  async (scenario) => {
    if (scenario === 'guest') mockCachedSession = null;
    if (scenario === 'anonymous')
      mockCachedSession = {
        user: { ...ACCOUNT, isAnonymous: true },
        sessionCookie: 'anonymous-cookie',
      };
    if (scenario === 'signed-out')
      useAuthStore.setState({ isInitialized: true, user: null, sessionCookie: null });
    render(<RootLayout />);
    await restoreLocal(scenario !== 'opt-out');
    await waitFor(() => expect(storage.startNativeRecording).toHaveBeenCalledTimes(1));
    await restoreAccount();
    await stopRecording();
    expect(dictations()).toHaveLength(0);
  },
);

it('preserves a fresh fallback intent while local hydration is pending', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  items.set('keyboard_handoff_intent_at_ms', String(Date.now()));
  render(<RootLayout />);
  await settle();
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
  await restoreLocal();
  expect(storage.startNativeRecording).toHaveBeenCalledTimes(1);
});

it('does not start a deferred recording after cancellation', async () => {
  const screen = render(<RootLayout />);
  await settle();
  items.set('keyboard_cancel_requested', '1');
  await restoreLocal();
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
  screen.unmount();
  expect(items.has('hotkey_js_ready_at_ms')).toBe(false);
});

it('releases startup after a local hydration failure without guessing identity', async () => {
  mockCachedSession = null;
  mockHydrate.mockRejectedValueOnce(new Error('storage unavailable'));
  render(<RootLayout />);
  await act(async () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', usageAnalyticsEnabled: false },
      isLoading: false,
    });
    configReady.resolve();
  });
  await waitFor(() => expect(storage.startNativeRecording).toHaveBeenCalledTimes(1));
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toHaveLength(0);
});

it('removes pending startup work on unmount', async () => {
  const screen = render(<RootLayout />);
  await settle();
  screen.unmount();
  await restoreLocal();
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
  expect(storage.markHotkeyJsReady).not.toHaveBeenCalled();
});

it('coalesces duplicate URLs and their fallback intent into one recording', async () => {
  let deliverUrl: ((event: { url: string }) => void) | undefined;
  jest.spyOn(Linking, 'addEventListener').mockImplementation((_type, listener) => {
    deliverUrl = listener;
    return mockSubscription as unknown as ReturnType<typeof Linking.addEventListener>;
  });
  items.set('keyboard_handoff_intent_at_ms', String(Date.now()));
  render(<RootLayout />);
  await settle();
  act(() => deliverUrl!({ url: 'openwhispr://keyboard-dictation?hostBundle=com.example.host' }));
  await restoreLocal();
  expect(storage.startNativeRecording).toHaveBeenCalledTimes(1);
  expect(items.get('keyboard_return_bundle')).toBe('com.example.host');
  expect(items.has('keyboard_handoff_intent_at_ms')).toBe(false);
});

it('keeps a cached account capture queued while another account is validated', async () => {
  render(<RootLayout />);
  await restoreLocal();
  await waitFor(() => expect(storage.startNativeRecording).toHaveBeenCalledTimes(1));
  await restoreAccount({ ...ACCOUNT, id: 'different-account' });
  await stopRecording();
  expect(dictations()).toHaveLength(0);
  await restoreAccount();
  await waitFor(() => expect(dictations()).toHaveLength(1));
  expect(
    mockRequests
      .filter((batch) => batch.events.some((event) => event.event_name === 'dictation_completed'))
      .map((batch) => batch.expected_user_id),
  ).toEqual(['restored-account']);
});

it('releases an ordinary native start only after local startup and counts its delivered text', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  const nativeJobId = `${Date.now()}-pending-native`;
  items.set('keyboard_recording_job_id', nativeJobId);
  storage.markHotkeyJsReady.mockImplementation(() => {
    expect(useConfigStore.getState().config).not.toBeNull();
    expect(useOnboardingStore.getState().hydrated).toBe(true);
    mockBackgroundStartedListener!();
  });
  render(<RootLayout />);
  await settle();
  expect(storage.markHotkeyJsReady).not.toHaveBeenCalled();
  await restoreLocal();
  expect(items.get('keyboard_recording_job_id')).toBe(nativeJobId);
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toHaveLength(1);
});

it('lets a queued URL supersede the original native job before native readiness is released', async () => {
  const nativeJobId = `${Date.now()}-superseded-native`;
  items.set('keyboard_recording_job_id', nativeJobId);
  let nativeReplays = 0;
  storage.markHotkeyJsReady.mockImplementation(() => {
    // The production Swift gate checks this exact original-job ownership before replay.
    if (items.get('keyboard_recording_job_id') === nativeJobId) {
      nativeReplays += 1;
      mockBackgroundStartedListener!();
    }
  });
  render(<RootLayout />);
  await settle();
  await restoreLocal();
  expect(storage.startNativeRecording).toHaveBeenCalledTimes(1);
  expect(nativeReplays).toBe(0);
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toHaveLength(1);
});

it('keeps a pending cancellation visible to native replay while releasing readiness', async () => {
  render(<RootLayout />);
  await settle();
  items.set('keyboard_cancel_requested', '1');
  storage.markHotkeyJsReady.mockImplementation(() => {
    expect(items.get('keyboard_cancel_requested')).toBe('1');
  });
  await restoreLocal();
  expect(storage.markHotkeyJsReady).toHaveBeenCalledTimes(1);
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
});

it('does not revive an ordinary native job after the keyboard times out waiting for startup', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  const nativeJobId = `${Date.now()}-timed-out-native`;
  items.set('keyboard_recording_job_id', nativeJobId);
  let nativeReplays = 0;
  storage.markHotkeyJsReady.mockImplementation(() => {
    if (
      items.get('keyboard_recording_job_id') === nativeJobId &&
      items.get('keyboard_cancel_requested') !== '1'
    ) {
      nativeReplays += 1;
      mockBackgroundStartedListener!();
    }
  });
  render(<RootLayout />);
  await settle();
  // handleDarwinStartFallback cancels the original pending job before showing its retry state.
  items.set('keyboard_cancel_requested', '1');
  await restoreLocal();
  expect(storage.markHotkeyJsReady).toHaveBeenCalledTimes(1);
  expect(nativeReplays).toBe(0);
});

it('waits for the asynchronous local cached session before releasing cold recording', async () => {
  const cacheReady = deferred<typeof mockCachedSession>();
  mockReadCachedSession.mockReturnValueOnce(cacheReady.promise);
  render(<RootLayout />);
  await restoreLocal();
  expect(storage.startNativeRecording).not.toHaveBeenCalled();
  expect(storage.markHotkeyJsReady).not.toHaveBeenCalled();
  expect(useAuthStore.getState().isInitialized).toBe(false);
  await act(async () => {
    cacheReady.resolve(mockCachedSession);
  });
  expect(storage.startNativeRecording).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().isInitialized).toBe(false);
  await restoreAccount();
  await stopRecording();
  expect(dictations()).toHaveLength(1);
});
