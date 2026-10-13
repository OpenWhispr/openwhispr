import { startKeyboardToneSync, reconcileKeyboardToneFromAppGroup } from '@/lib/keyboardToneSync';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

const store: Record<string, string> = {};

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
      return true;
    },
    removeItem: (key: string) => {
      delete store[key];
      return true;
    },
  },
  APP_GROUP_KEYS: {
    KEYBOARD_DICTATION_TONE: 'keyboard_dictation_tone',
    KEYBOARD_RECORDING_TONE: 'keyboard_recording_tone',
    KEYBOARD_RECORDING_TONE_JOB_ID: 'keyboard_recording_tone_job_id',
    KEYBOARD_TONE_APPLICABLE: 'keyboard_tone_applicable',
  },
}));

jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

jest.mock('@/services/storage/StorageService', () => ({
  StorageService: { saveConfig: jest.fn(async () => {}) },
}));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('startKeyboardToneSync applicability', () => {
  it('writes applicable=0 in private mode and 1 in cloud with cleanup on', () => {
    useProcessingModeStore.setState({ activeMode: 'private' });
    useConfigStore.setState({ config: { defaultMode: 'cloud', cleanupEnabled: true } as any });

    const stop = startKeyboardToneSync();
    expect(store.keyboard_tone_applicable).toBe('0');

    useProcessingModeStore.getState().setActiveMode('cloud', true);
    expect(store.keyboard_tone_applicable).toBe('1');
    stop();
  });
});

describe('reconcileKeyboardToneFromAppGroup', () => {
  it('does not overwrite a non-default config tone when the App Group key is missing', async () => {
    useProcessingModeStore.setState({ activeMode: 'cloud' });
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardTone: 'formal' } as any,
      isLoading: false,
    });
    delete store.keyboard_dictation_tone;

    await reconcileKeyboardToneFromAppGroup();

    expect(useConfigStore.getState().config?.keyboardTone).toBe('formal');
    expect(store.keyboard_dictation_tone).toBe('formal');
  });

  it('lets an explicit App Group value win after a keyboard change', async () => {
    useConfigStore.setState({
      config: { defaultMode: 'cloud', keyboardTone: 'default' } as any,
      isLoading: false,
    });
    store.keyboard_dictation_tone = 'excited';

    await reconcileKeyboardToneFromAppGroup();

    expect(useConfigStore.getState().config?.keyboardTone).toBe('excited');
  });
});
