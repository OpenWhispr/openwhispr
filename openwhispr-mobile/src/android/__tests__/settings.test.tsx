import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useConfigStore } from '@/store/useConfigStore';
import { applyHistoryRetention } from '@/android/pipeline';
import { setInsightsSyncConsent } from '@/android/insights';
import { ModelRow } from '../settings/ModelRow';
import { ModelListRow } from '../settings/ModelListRow';
import ModelScreen from '../settings/ModelScreen';
import { MODEL_ROWS } from '../settings/modelCatalog';
import HistoryScreen from '../settings/HistoryScreen';
import AnalyticsScreen from '@/screens/PrivacyDataScreen.android';
import { noOrphan } from '../settings/strings';
import { useSettingsToast } from '../settings/kit';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: () => mockBack(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => ({ kind: 'speech' }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, Circle: View, Path: View, Rect: View };
});
jest.mock('expo-haptics', () => ({
  performAndroidHapticsAsync: jest.fn(async () => undefined),
  AndroidHaptics: { Confirm: 'confirm', Clock_Tick: 'clock-tick' },
}));
let mockReady = false;
const mockRemoveModel = jest.fn(async (_id: string) => undefined);
jest.mock('../models', () => ({
  ANDROID_MODELS: {
    'parakeet-v3': { title: 'Parakeet v3', bytes: 670478772 },
    'moonshine-small': { title: 'Moonshine Small', bytes: 142300974 },
    'moonshine-tiny': { title: 'Moonshine Tiny', bytes: 45233659 },
  },
  removeAndroidModel: (id: string) => mockRemoveModel(id),
  modelReady: async () => mockReady,
  downloadAndroidModel: jest.fn(async () => undefined),
  cancelAndroidDownload: jest.fn(async () => undefined),
  useModelDownloads: () => ({}),
}));
jest.mock('@/android/pipeline', () => ({ applyHistoryRetention: jest.fn(async () => {}) }));
jest.mock('@/android/insights', () => ({
  setInsightsSyncConsent: jest.fn(async () => {}),
  useInsights: () => false,
}));
let mockSignedIn = true;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: object | null }) => unknown) =>
    selector({ user: mockSignedIn ? { id: 'a', isAnonymous: false } : null }),
}));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: (user: unknown) => !user }));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: (selector: (state: { policyBlocked: boolean }) => unknown) =>
    selector({ policyBlocked: false }),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));

const mockSave = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockReady = false;
  mockSignedIn = true;
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  // Left pending: the screens run as with animations on, and no late state update lands.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
  mockSave.mockReset().mockImplementation(async (change: object) => {
    useConfigStore.setState((state) => ({ config: { ...state.config!, ...change }, error: null }));
  });
  useConfigStore.setState({
    config: { androidHistoryDays: 30, usageAnalyticsEnabled: true } as never,
    error: null,
    updateConfig: mockSave,
  } as never);
});

describe('V1 Ring model row', () => {
  const parakeet = MODEL_ROWS[0];
  const row = (progress: number | undefined, onSettled = jest.fn()) => (
    <ModelRow
      row={parakeet}
      ready={false}
      inUse={false}
      progress={progress}
      dimmed={false}
      reduceMotion
      onSettled={onSettled}
    />
  );

  it('offers Download, with Recommended, until a download starts', () => {
    render(row(undefined));
    expect(screen.getByLabelText('downloadModel')).toBeTruthy();
    expect(screen.getByText('recommended')).toBeTruthy();
    expect(screen.queryByLabelText('cancelDownload')).toBeNull();
  });

  it('turns into a ring that is also Cancel, then sets up after the last byte', () => {
    const view = render(row(0.38));
    expect(screen.getByLabelText('cancelDownload')).toBeTruthy();
    expect(screen.getByText(/sizeOf/)).toBeTruthy();
    view.rerender(row(0.99));
    expect(screen.getByText('settingUp')).toBeTruthy();
  });

  it('draws the check with one CONFIRM haptic once the model is on the phone', async () => {
    const onSettled = jest.fn();
    const view = render(row(0.99, onSettled));
    mockReady = true;
    view.rerender(row(undefined, onSettled));
    // Still setting up while the model is checked: never back to Download.
    expect(screen.queryByLabelText('downloadModel')).toBeNull();
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(true));
    expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith('confirm');
    expect(screen.queryByLabelText('downloadModel')).toBeNull();
  });

  it('stays on Download when a download ends without the model (cancelled or failed)', async () => {
    const onSettled = jest.fn();
    const view = render(row(0.5, onSettled));
    view.rerender(row(undefined, onSettled));
    await act(async () => {});
    expect(onSettled).toHaveBeenCalledWith(false);
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
    expect(screen.getByLabelText('downloadModel')).toBeTruthy();
  });
});

describe('8.3 v2 model list', () => {
  const parakeet = MODEL_ROWS[0];
  const row = (state: 'absent' | 'downloading' | 'ready' | 'inUse', handlers = {}) => (
    <ModelListRow
      row={parakeet}
      state={state}
      progress={state === 'downloading' ? 0.38 : undefined}
      dimmed={false}
      reduceMotion
      onDownload={jest.fn()}
      onUse={jest.fn()}
      onRemove={jest.fn()}
      onSettled={jest.fn()}
      {...handlers}
    />
  );

  it('offers a download, with Recommended, while the model is not on the phone', () => {
    const onDownload = jest.fn();
    render(row('absent', { onDownload }));
    expect(screen.getByText('recommended')).toBeTruthy();
    expect(screen.queryByLabelText('removeModel')).toBeNull();
    fireEvent.press(screen.getByLabelText('downloadModel'));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('cancels from the ring while downloading', () => {
    render(row('downloading'));
    expect(screen.getByLabelText('cancelDownload')).toBeTruthy();
    expect(screen.getByText(/sizeOf/)).toBeTruthy();
  });

  it('chooses a downloaded model with a tick, and offers its bin', () => {
    const onUse = jest.fn();
    const onRemove = jest.fn();
    render(row('ready', { onUse, onRemove }));
    expect(screen.queryByText('recommended')).toBeNull();
    fireEvent.press(screen.getByRole('radio'));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledWith('clock-tick');
    fireEvent.press(screen.getByLabelText('removeModel'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('shows the model in use as checked and does nothing on tap', () => {
    const onUse = jest.fn();
    render(row('inUse', { onUse }));
    expect(screen.getByRole('radio').props.accessibilityState.checked).toBe(true);
    fireEvent.press(screen.getByRole('radio'));
    expect(onUse).not.toHaveBeenCalled();
  });

  it('removes a model with Undo, deleting its files only when the snackbar closes', async () => {
    mockReady = true;
    useConfigStore.setState({ config: { androidSpeechModel: 'parakeet-v3' } as never });
    render(<ModelScreen />);
    await waitFor(() => expect(screen.getAllByLabelText('removeModel')).toHaveLength(3));
    expect(screen.getByText('modelsOnPhone')).toBeTruthy();
    // Moonshine Small is on the phone but not in use: no dialog.
    fireEvent.press(screen.getAllByLabelText('removeModel')[1]);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(useSettingsToast.getState().message).toBe('removedModel');
    expect(mockRemoveModel).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText('downloadModel')).toHaveLength(1);
    // Undo, as the snackbar's button does it.
    act(() => {
      useSettingsToast.getState().action!.onPress();
      useSettingsToast.setState({ action: undefined });
    });
    expect(screen.queryByLabelText('downloadModel')).toBeNull();
    // The model in use warns first; the files go once the snackbar closes.
    fireEvent.press(screen.getAllByLabelText('removeModel')[0]);
    expect(Alert.alert).toHaveBeenCalledWith('removeTitle', 'removeInUseBody', expect.any(Array));
    const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
    act(() => buttons.find((button) => button.style === 'destructive')!.onPress!());
    expect(screen.getAllByLabelText('downloadModel')).toHaveLength(1);
    expect(mockRemoveModel).not.toHaveBeenCalled();
    await act(async () => useSettingsToast.getState().action!.onClose());
    expect(mockRemoveModel).toHaveBeenCalledWith('parakeet-v3');
  });
});

describe('Keep history', () => {
  const confirmLast = () => {
    const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)![2]!;
    return buttons.find((button) => button.style === 'destructive')!.onPress!;
  };

  it('asks before a shorter period and prunes only after the save lands', async () => {
    render(<HistoryScreen />);
    fireEvent.press(screen.getByText('sevenDays'));
    expect(Alert.alert).toHaveBeenCalledWith(
      'deleteOlderTitle',
      'deleteOlderBody',
      expect.any(Array),
    );
    await act(async () => confirmLast()());
    expect(useConfigStore.getState().config?.androidHistoryDays).toBe(7);
    expect(applyHistoryRetention).toHaveBeenCalledTimes(1);
    expect(useSettingsToast.getState().message).toBe('olderDeleted');
  });

  it('saves a longer period without asking', async () => {
    render(<HistoryScreen />);
    await act(async () => fireEvent.press(screen.getByText('forever')));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(useConfigStore.getState().config?.androidHistoryDays).toBe(-1);
  });

  it('does not prune when the save fails, and keeps the previous period', async () => {
    mockSave.mockImplementationOnce(async () => {
      useConfigStore.setState({ error: 'disk full' });
    });
    render(<HistoryScreen />);
    fireEvent.press(screen.getByText('dontSave'));
    await act(async () => confirmLast()());
    expect(applyHistoryRetention).not.toHaveBeenCalled();
    expect(useConfigStore.getState().config?.androidHistoryDays).toBe(30);
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('saves once while a save is still pending', async () => {
    let resolve!: () => void;
    mockSave.mockImplementationOnce(
      (change: object) =>
        new Promise<void>((done) => {
          resolve = () => {
            useConfigStore.setState((state) => ({ config: { ...state.config!, ...change } }));
            done();
          };
        }),
    );
    render(<HistoryScreen />);
    fireEvent.press(screen.getByText('sevenDays'));
    const confirm = confirmLast();
    act(() => {
      confirm();
      confirm();
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(applyHistoryRetention).toHaveBeenCalledTimes(1);
  });
});

describe('Analytics', () => {
  it('asks a signed-out person to sign in before syncing statistics', () => {
    mockSignedIn = false;
    render(<AnalyticsScreen />);
    fireEvent.press(screen.getByRole('switch', { name: 'syncStats' }));
    expect(Alert.alert).toHaveBeenCalledWith(
      'statsSignInTitle',
      'statsSignInBody',
      expect.any(Array),
    );
    expect(setInsightsSyncConsent).not.toHaveBeenCalled();
  });

  it('sends people to Keep history when it is set to Don’t save', () => {
    useConfigStore.setState({ config: { androidHistoryDays: 0 } as never });
    render(<AnalyticsScreen />);
    fireEvent.press(screen.getByRole('switch', { name: 'syncStats' }));
    expect(Alert.alert).toHaveBeenCalledWith(
      'statsHistoryTitle',
      'statsHistoryBody',
      expect.any(Array),
    );
  });

  it('turns usage analytics off and says so', async () => {
    render(<AnalyticsScreen />);
    await act(async () => fireEvent.press(screen.getByRole('switch', { name: 'usageAnalytics' })));
    expect(useConfigStore.getState().config?.usageAnalyticsEnabled).toBe(false);
    expect(useSettingsToast.getState().message).toBe('analyticsOff');
  });
});

describe('noOrphan', () => {
  it('binds the last two words, or three when the last is short', () => {
    expect(noOrphan('Fix filler words, grammar and lists')).toBe(
      'Fix filler words, grammar and lists',
    );
    expect(noOrphan('Turn on dictation history first in it')).toBe(
      'Turn on dictation history first in it',
    );
    expect(noOrphan('Two words')).toBe('Two words');
  });
});
