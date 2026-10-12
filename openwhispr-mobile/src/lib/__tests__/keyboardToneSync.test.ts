import { snapshotKeyboardTone, readKeyboardToneSnapshot } from '@/lib/keyboardToneSync';

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

describe('keyboardToneSync snapshot', () => {
  it('snapshots the live tone bound to the job id', () => {
    store.keyboard_dictation_tone = 'excited';

    const snapped = snapshotKeyboardTone('job-1');

    expect(snapped).toBe('excited');
    expect(store.keyboard_recording_tone).toBe('excited');
    expect(store.keyboard_recording_tone_job_id).toBe('job-1');
    expect(readKeyboardToneSnapshot('job-1')).toBe('excited');
  });

  it('returns default when the job id does not match the snapshot', () => {
    store.keyboard_dictation_tone = 'formal';
    snapshotKeyboardTone('job-1');
    store.keyboard_dictation_tone = 'casual';

    expect(readKeyboardToneSnapshot('job-2')).toBe('default');
    expect(readKeyboardToneSnapshot('job-1')).toBe('formal');
  });

  it('defaults to default when nothing is stored', () => {
    expect(snapshotKeyboardTone('job-x')).toBe('default');
    expect(readKeyboardToneSnapshot('job-x')).toBe('default');
  });

  it('ignores an invalid stored value', () => {
    store.keyboard_dictation_tone = 'nonsense';
    expect(snapshotKeyboardTone('job-1')).toBe('default');
  });
});
