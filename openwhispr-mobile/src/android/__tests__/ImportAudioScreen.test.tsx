import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@/locales/en/translation.json';
import de from '@/locales/de/translation.json';
import { act, fireEvent, render } from '@testing-library/react-native';
import ImportAudioScreen from '../ImportAudioScreen';

const testI18n = createInstance();
beforeAll(async () => {
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en, de },
    interpolation: { escapeValue: false },
  });
});
const renderImport = () =>
  render(
    <I18nextProvider i18n={testI18n}>
      <ImportAudioScreen />
    </I18nextProvider>,
  );

const mockPick = jest.fn(async () => undefined);
const mockCancel = jest.fn();
const mockReplace = jest.fn();
let mockFeature: (() => void) | undefined;
let mockBlur: (() => void) | undefined;
let mockAuthChange: ((state: unknown, previous: unknown) => void) | undefined;
let mockOptions: { onComplete: (text: string, name: string) => void };
let mockMode = 'private';
let mockRoute = { provider: 'local', cleanupRoute: { mode: 'local' } };
const mockTarget = { ownerId: 'a', spaceId: 1, label: 'Research', isPrivate: true };
const mockSave = jest.fn((..._args: unknown[]) => ({ id: 99 }));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ folderId: '5' }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: jest.fn() }),
  usePreventRemove: jest.fn(),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('../ui', () => ({
  Page: ({ children }: any) => children,
  Card: ({ children }: any) => children,
  Button: ({ label, onPress, disabled }: any) =>
    require('react').createElement(
      require('react-native').Pressable,
      { onPress, disabled, accessibilityRole: 'button', accessibilityLabel: label },
      require('react').createElement(require('react-native').Text, null, label),
    ),
  styles: {},
}));
jest.mock('@/hooks/useFileUpload', () => ({
  useFileUpload: (options: typeof mockOptions) => {
    mockOptions = options;
    return {
      isProcessing: false,
      currentText: '',
      stage: 'transcribing',
      cancel: mockCancel,
      pickAndTranscribeFile: mockPick,
    };
  },
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({
    register: async ({ feature }: { feature: () => void }) => {
      mockFeature = feature;
    },
  }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'a' } }),
    subscribe: (callback: typeof mockAuthChange) => {
      mockAuthChange = callback;
      return jest.fn();
    },
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (select: (state: unknown) => unknown) => select({ activeMode: mockMode }),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (select: (state: unknown) => unknown) => select({ config: {} }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ usage: null }) },
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: { getState: () => ({ loadNotes: jest.fn(), loadFolders: jest.fn() }) },
}));
jest.mock('@/lib/inferenceRouting', () => ({ snapshotTranscriptionJob: () => mockRoute }));
jest.mock('@/lib/accountAccess', () => ({
  accountRequiredForCloud: () => false,
  showAccountRequiredAlert: jest.fn(),
}));
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { audioUploadStart: 'upload' },
  buildUsageGateParams: jest.fn(),
}));
jest.mock('@/lib/notes/importDestination', () => ({
  ImportDestinationError: class extends Error {
    translationKey = '';
    constructor(key: string, message: string) {
      super(message);
      this.translationKey = key;
    }
  },
  resolveImportDestination: () => mockTarget,
  saveImportedNote: (...args: unknown[]) => mockSave(...args),
}));

beforeEach(async () => {
  await testI18n.changeLanguage('en');
  jest.clearAllMocks();
  mockMode = 'private';
  mockRoute = { provider: 'local', cleanupRoute: { mode: 'local' } };
  mockFeature = undefined;
});

it('starts no processing until the user chooses a file, then opens the saved note', async () => {
  const view = renderImport();
  expect(mockPick).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(view.getByText('Choose audio file')));
  expect(mockPick).toHaveBeenCalledWith(mockRoute);
  act(() => mockOptions.onComplete('Transcript', 'Interview.wav'));
  expect(mockSave).toHaveBeenCalledWith(
    mockTarget,
    'Transcript',
    'Interview.wav',
    'Imported audio',
  );
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/(notes)/99');
});

it('explains provider cleanup even for a private import', () => {
  mockRoute.cleanupRoute.mode = 'providers';
  const { getByText } = renderImport();
  expect(getByText(/Transcript text is sent to your selected cleanup provider/)).toBeTruthy();
});

it('ignores a delayed paywall callback after leaving the import screen', async () => {
  mockMode = 'cloud';
  mockRoute.provider = 'cloud';
  const view = renderImport();
  await act(async () => fireEvent.press(view.getByText('Choose audio file')));
  expect(mockFeature).toBeDefined();
  act(() => mockBlur?.());
  await act(async () => mockFeature?.());
  expect(mockPick).not.toHaveBeenCalled();
});

it('cancels on account change and refuses a delayed paywall callback', async () => {
  mockMode = 'cloud';
  mockRoute.provider = 'cloud';
  const view = renderImport();
  await act(async () => fireEvent.press(view.getByText('Choose audio file')));
  act(() => mockAuthChange?.({ user: { id: 'b' } }, { user: { id: 'a' } }));
  await act(async () => mockFeature?.());
  expect(mockCancel).toHaveBeenCalled();
  expect(mockPick).not.toHaveBeenCalled();
  expect(view.getByText(/Your account changed/)).toBeTruthy();
});

it('renders the selected language for private provider disclosure and import actions', async () => {
  await testI18n.changeLanguage('de');
  mockRoute.cleanupRoute.mode = 'providers';
  const view = renderImport();
  expect(view.getByText(de.android.importPrivateRemoteCleanup)).toBeTruthy();
  expect(view.getByText('Audiodatei auswählen')).toBeTruthy();
  expect(view.getByText('Speichern in: Research')).toBeTruthy();
  expect(view.queryByText(en.android.importPrivateRemoteCleanup)).toBeNull();
  await act(async () => fireEvent.press(view.getByText('Audiodatei auswählen')));
  expect(mockPick).toHaveBeenCalledWith(mockRoute);
});
