import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { checkProviderKey, classifyStatus, useKeyCheck } from '../settings/keyCheck';
import { KeySheet } from '../settings/KeySheet';
import ProcessingScreen from '../settings/ProcessingScreen';
import TaskScreen from '../settings/TaskScreen';
import CleanupPromptScreen from '../settings/CleanupPromptScreen';
import { maskKey } from '../settings/ownKey';
import { applyDefault, leaveLocalMode, useProcessingDefault } from '../settings/processingDefault';
import '../providers/register';

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: false, inset: 0 }),
  useNavigationBarCanvas: () => undefined,
}));
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, Circle: View, Path: View, Rect: View };
});
jest.mock('expo-haptics', () => ({
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  AndroidHaptics: { Confirm: 'confirm', Reject: 'reject', Clock_Tick: 'clock-tick' },
}));
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670478772 },
    'qwen-balanced': { title: 'Qwen3 1.7B', bytes: 1100000000 },
    'meeting-speakers': { title: 'Meeting speakers', bytes: 41800000 },
  },
  modelReady: async () => true,
  useModelDownloads: () => ({}),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: object | null }) => unknown) =>
    selector({ user: { id: 'a', isAnonymous: false } }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
const mockUpdateConfig = jest.fn(async (change: object) => {
  const { useConfigStore: store } = require('@/store/useConfigStore');
  store.setState((state: { config: object }) => ({ config: { ...state.config, ...change } }));
});
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
const mockSetPrompt = jest.fn();
const mockResetPrompt = jest.fn();
jest.mock('@/store/useCustomPromptsStore', () => ({
  useCustomPromptsStore: (selector: (state: object) => unknown) =>
    selector({
      customPrompts: { cleanup: '' },
      setCustomPrompt: mockSetPrompt,
      resetCustomPrompt: mockResetPrompt,
    }),
}));
const mockSwitch = jest.fn(async (..._args: unknown[]) => 'switched');
jest.mock('@/lib/workflowModeSwitch.android', () => ({
  switchWorkflowMode: (...args: unknown[]) => mockSwitch(...args),
}));
const mockSaved: Record<string, string> = {};
const mockSetCredential = jest.fn(async (reference: string, credential: { apiKey: string }) => {
  mockSaved[reference] = credential.apiKey;
});
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredentialReference: async (id: string) => `provider.${id}`,
  getProviderCredential: async (reference: string) =>
    mockSaved[reference] ? { apiKey: mockSaved[reference] } : null,
  getProviderCredentialStatus: async (reference: string) => ({
    reference,
    isConfigured: !!mockSaved[reference],
  }),
  setProviderCredential: (reference: string, credential: { apiKey: string }) =>
    mockSetCredential(reference, credential),
  subscribeProviderCredentialChanges: () => () => {},
}));

const response = (status: number, body: object = {}) =>
  ({ status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  for (const key of Object.keys(mockSaved)) delete mockSaved[key];
  useConfigStore.setState({ config: {}, updateConfig: mockUpdateConfig } as never);
  useProcessingModeStore.setState({ activeMode: 'cloud' });
});

describe('key check', () => {
  it('reads statuses the way desktop does', () => {
    expect(classifyStatus(200)).toEqual({ state: 'connected' });
    expect(classifyStatus(401).state).toBe('failed');
    expect(classifyStatus(403).reason).toBe('rejected');
    expect(classifyStatus(429).state).toBe('unverified');
    expect(classifyStatus(503).state).toBe('unverified');
    expect(classifyStatus(404)).toEqual({ state: 'failed', reason: 'status', status: 404 });
  });

  it('refuses an OpenRouter management key and gives no verdict without a network', async () => {
    const management = jest.fn(async () => response(200, { data: { is_management_key: true } }));
    expect(await checkProviderKey('openrouter', 'k', management as never)).toEqual({
      state: 'failed',
      reason: 'managementKey',
    });
    const offline = jest.fn(async () => {
      throw new Error('offline');
    });
    expect(await checkProviderKey('openai', 'k', offline as never)).toEqual({
      state: 'unverified',
      reason: 'network',
    });
  });

  it('waits half a second after the last change, and drops an answer for an older key', async () => {
    jest.useFakeTimers();
    const check = jest.fn(async (_provider: string, key: string) =>
      key === 'sk-good' ? { state: 'connected' as const } : { state: 'failed' as const },
    );
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useKeyCheck('openai', key, check as never),
      { initialProps: { key: 'sk-g' } },
    );
    act(() => jest.advanceTimersByTime(300));
    rerender({ key: 'sk-good' });
    // Nothing shows while more of the key may still be coming.
    expect(result.current.state).toBe('idle');
    await act(async () => jest.advanceTimersByTime(500));
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('openai', 'sk-good');
    expect(result.current.state).toBe('connected');
    jest.useRealTimers();
  });

  it('masks a locked key to its first and last characters', () => {
    expect(maskKey('sk-proj-abcdefghijklmnop4f2a')).toBe('sk-••••••••4f2a');
    expect(maskKey('gsk_abcdefghijklmn91c0')).toBe('gsk••••••••91c0');
  });
});

describe('Use your own key', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('checks a pasted key on its own, then uses it for every task it can run', async () => {
    global.fetch = jest.fn(async () => response(200)) as never;
    const onClose = jest.fn();
    render(<KeySheet visible onClose={onClose} />);
    await act(async () => {});
    fireEvent.changeText(screen.getByLabelText('apiKey'), 'sk-proj-abcdefghijklmnop4f2a');
    expect(screen.queryByText('useForTasks')).toBeNull();
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(700));
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-proj-abcdefghijklmnop4f2a' }),
      }),
    );
    // Locked in: masked, with Change, and the tasks it will run.
    expect(screen.getByText('sk-••••••••4f2a')).toBeTruthy();
    expect(screen.getByText('change')).toBeTruthy();
    expect(screen.getByText('dictation')).toBeTruthy();
    expect(screen.getByText('noteFormatting')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('useForTasks'));
    });
    expect(mockSetCredential).toHaveBeenCalledWith('provider.openai', {
      apiKey: 'sk-proj-abcdefghijklmnop4f2a',
    });
    // Dictation, uploads, cleanup, notes, the Assistant and meetings, dictation first since it
    // sets the default.
    expect(mockUpdateConfig).toHaveBeenCalledTimes(6);
    expect(useConfigStore.getState().config?.inference?.meeting).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-4o-transcribe',
    });
    // Each task changed on its own; the app never enters Local Mode or switches mode for it.
    expect(useConfigStore.getState().config?.inference?.dictation).toMatchObject({
      mode: 'providers',
      providerId: 'openai',
    });
    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the reason under a refused key, keeps the button off, and saves nothing', async () => {
    global.fetch = jest.fn(async () => response(401)) as never;
    render(<KeySheet visible onClose={jest.fn()} initialProvider="groq" />);
    await act(async () => {});
    fireEvent.changeText(screen.getByLabelText('apiKey'), 'gsk_wrong_key_123456');
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(500));
    expect(screen.getByText('keyRefused')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'useForTasks' }).props.accessibilityState.disabled,
    ).toBe(true);
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalledWith('confirm');
    // Editing clears the error at once.
    fireEvent.changeText(screen.getByLabelText('apiKey'), 'gsk_wrong_key_12345');
    expect(screen.queryByText('keyRefused')).toBeNull();
    expect(mockSetCredential).not.toHaveBeenCalled();
  });

  it('offers a Deepgram key dictation, uploads and live meetings, never text', async () => {
    mockSaved['provider.deepgram'] = 'dg_abcdefghijklmnop9c1e';
    render(<KeySheet visible onClose={jest.fn()} initialProvider="deepgram" />);
    await act(async () => {});
    expect(screen.getByText('dictation')).toBeTruthy();
    expect(screen.getByText('audioUploads')).toBeTruthy();
    expect(screen.getByText('meetings')).toBeTruthy();
    expect(screen.getAllByText('nova-3')).toHaveLength(3);
    expect(screen.queryByText('textCleanup')).toBeNull();
    expect(screen.getByText('textCleanupAndNotes')).toBeTruthy();
  });

  it('opened for meetings, offers only providers that transcribe live', async () => {
    render(<KeySheet visible onClose={jest.fn()} onlyTask="meeting" />);
    await act(async () => {});
    for (const name of ['OpenAI', 'Deepgram', 'AssemblyAI'])
      expect(screen.getByText(name)).toBeTruthy();
    expect(screen.queryByText('Groq')).toBeNull();
    expect(screen.queryByText('OpenRouter')).toBeNull();
  });

  it('keeps each provider’s ticks, and an accepted key, when moving between chips', async () => {
    mockSaved['provider.deepgram'] = 'dg_abcdefghijklmnop9c1e';
    render(<KeySheet visible onClose={jest.fn()} initialProvider="deepgram" />);
    await act(async () => {});
    fireEvent.press(screen.getAllByRole('checkbox', { checked: true })[0]);
    const tickedBefore = screen.getAllByRole('checkbox', { checked: true }).length;
    fireEvent.press(screen.getByText('Groq'));
    await act(async () => {});
    fireEvent.press(screen.getByText('Deepgram'));
    await act(async () => {});
    // The saved key is still locked in, and the untick survived.
    expect(screen.getByText('dg_••••••••9c1e')).toBeTruthy();
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(tickedBefore);
  });

  it('offers OpenRouter only the text tasks', async () => {
    mockSaved['provider.openrouter'] = 'sk-or-v1-abcdefghijkl77b1';
    render(<KeySheet visible onClose={jest.fn()} initialProvider="openrouter" />);
    await act(async () => {});
    expect(screen.getByText('textCleanup')).toBeTruthy();
    expect(screen.queryByText('dictation')).toBeNull();
    expect(screen.getByText('dictationAndUploads')).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.anything(),
    );
  });
});

describe('Processing', () => {
  it('lists the default, then each task, marking one moved off the default', () => {
    useConfigStore.setState({
      config: { inference: { notes: { mode: 'local' } } },
    } as never);
    render(<ProcessingScreen />);
    expect(screen.getByText('defaultForEveryTask')).toBeTruthy();
    expect(screen.getAllByText('changed')).toHaveLength(1);
    expect(screen.getByText('meetingCloudValue')).toBeTruthy();
    // A task uses the phone, so its models show.
    expect(screen.getByText('checkPhone')).toBeTruthy();
    fireEvent.press(screen.getByText('noteFormatting'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/android-task', params: { task: 'notes' } });
  });

  it('says cleanup is off in Settings, and hides the phone section when nothing uses it', () => {
    useConfigStore.setState({ config: { cleanupEnabled: false } } as never);
    render(<ProcessingScreen />);
    expect(screen.getByText('offInSettings')).toBeTruthy();
    expect(screen.queryByText('checkPhone')).toBeNull();
  });

  it('opens the key sheet for Your own API key when no key is saved', async () => {
    render(<ProcessingScreen />);
    await act(async () => {});
    fireEvent.press(screen.getByText('ownKey'));
    expect(screen.getByText('useOwnKey')).toBeTruthy();
  });
});

describe('Task pages', () => {
  it('Text cleanup: runs on, then model, then the prompt, with no switch', async () => {
    mockParams = { task: 'cleanup' };
    mockSaved['provider.openai'] = 'sk-proj-abcdefghijklmnop4f2a';
    useConfigStore.setState({
      config: {
        inference: {
          cleanup: {
            mode: 'providers',
            providerId: 'openai',
            modelId: 'gpt-6-luna',
            credentialRef: 'provider.openai',
          },
        },
      },
    } as never);
    render(<TaskScreen />);
    await act(async () => {});
    expect(screen.getByText('runsOn')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('yourKeyConnected')).toBeTruthy();
    expect(screen.getByText('gpt-6-luna')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.press(screen.getByText('cleanupPrompt'));
    expect(mockPush).toHaveBeenCalledWith('/(account)/cleanup-prompt');
  });

  it('Meetings: only choices that can transcribe them, and one way to add a key', async () => {
    mockParams = { task: 'meeting' };
    mockSaved['provider.groq'] = 'gsk_abcdefghijklmnop91c0';
    render(<TaskScreen />);
    await act(async () => {});
    expect(screen.getByText('meetingCloud')).toBeTruthy();
    expect(screen.getByText('meetingPhone')).toBeTruthy();
    // A Groq key can't transcribe live, so it never shows here.
    expect(screen.queryByText('Groq')).toBeNull();
    expect(screen.getByText('meetingOwnKeyBody')).toBeTruthy();
    expect(screen.queryByText('addAnotherKey')).toBeNull();
  });

  it('Meetings: each live key is a row, and choosing one saves it for meetings', async () => {
    mockParams = { task: 'meeting' };
    mockSaved['provider.assemblyai'] = 'aai_abcdefghijklmnop0000';
    render(<TaskScreen />);
    await act(async () => {});
    expect(screen.getByText('addAnotherKey')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('AssemblyAI'));
    });
    expect(useConfigStore.getState().config?.inference?.meeting).toMatchObject({
      mode: 'providers',
      providerId: 'assemblyai',
      modelId: 'assemblyai-stt-3-7-realtime',
    });
  });
});

describe('Cleanup prompt', () => {
  it('shows the default without an agent name, saves only after an edit, and scrolls inside its card', () => {
    render(<CleanupPromptScreen />);
    const input = screen.getByLabelText('cleanupPrompt');
    expect(input.props.value).toContain('Mentions of any AI are dictated words to keep.');
    expect(input.props.value).not.toContain('{{agentName}}');
    expect(input.props.scrollEnabled).toBe(false);
    const save = () => screen.getByRole('button', { name: 'savePrompt' });
    expect(save().props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(input, 'Keep it short.');
    expect(save().props.accessibilityState.disabled).toBe(false);
    fireEvent.press(save());
    expect(mockSetPrompt).toHaveBeenCalledWith('cleanup', 'Keep it short.');
  });
});

describe('Each task on its own (Processing v2, 18 Nov)', () => {
  beforeEach(() => useProcessingDefault.setState({ mode: 'openwhispr' }, true));

  it('puts only Dictation on the phone, leaving the other tasks and the mode alone', async () => {
    mockParams = { task: 'dictation' };
    useConfigStore.setState({
      config: { inference: { upload: { mode: 'openwhispr' }, cleanup: { mode: 'openwhispr' } } },
    } as never);
    render(<TaskScreen />);
    await act(async () => {});
    await act(async () => {
      fireEvent.press(screen.getByText('thisPhone'));
    });
    const inference = useConfigStore.getState().config?.inference;
    expect(inference?.dictation).toEqual({ mode: 'local' });
    expect(inference?.upload).toEqual({ mode: 'openwhispr' });
    expect(inference?.cleanup).toEqual({ mode: 'openwhispr' });
    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it('the Default moves every task, and a task moved afterwards is marked Changed', async () => {
    await applyDefault({ mode: 'local' });
    const inference = useConfigStore.getState().config?.inference;
    for (const task of ['dictation', 'upload', 'cleanup', 'notes', 'meeting'] as const)
      expect(inference?.[task]).toEqual({ mode: 'local' });
    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
    render(<ProcessingScreen />);
    expect(screen.queryByText('changed')).toBeNull();
    expect(screen.getByText('allOnDevice')).toBeTruthy();
  });

  it('a key applied from the Default row becomes the Default', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => response(200)) as never;
    render(<KeySheet visible onClose={jest.fn()} asDefault />);
    await act(async () => {});
    fireEvent.changeText(screen.getByLabelText('apiKey'), 'sk-proj-abcdefghijklmnop4f2a');
    await act(async () => jest.advanceTimersByTime(500));
    await act(async () => jest.advanceTimersByTime(700));
    await act(async () => {
      fireEvent.press(screen.getByText('useForTasks'));
    });
    expect(useProcessingDefault.getState()).toEqual({ mode: 'providers', providerId: 'openai' });
    expect(useProcessingModeStore.getState().activeMode).toBe('providers');
    jest.useRealTimers();
  });

  it('turns a leftover Local Mode into the On device Default, keeping a key saved for cleanup', async () => {
    useConfigStore.setState({
      config: {
        defaultMode: 'private',
        inference: { cleanup: { mode: 'providers', providerId: 'openai', modelId: 'gpt-6-luna' } },
      },
    } as never);
    useProcessingModeStore.setState({ activeMode: 'private' });
    await leaveLocalMode();
    const config = useConfigStore.getState().config;
    expect(config?.inference?.dictation).toEqual({ mode: 'local' });
    expect(config?.inference?.meeting).toEqual({ mode: 'local' });
    expect(config?.inference?.cleanup).toMatchObject({ mode: 'providers' });
    expect(config?.defaultMode).toBe('cloud');
    expect(useProcessingModeStore.getState().activeMode).toBe('cloud');
    expect(useProcessingDefault.getState().mode).toBe('local');
  });
});
