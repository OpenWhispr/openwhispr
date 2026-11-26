import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, StyleSheet, Text, useColorScheme } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/android/shared/components/ui/GradientGlassSurface', () =>
  jest.requireMock('@/components/ui/GradientGlassSurface'),
);

// Voice screens: the store, router and the shared children they host.
let mockParams: Record<string, string | undefined> = {};
const mockProfile = {
  id: 2,
  displayName: 'Alice',
  email: null,
  isOwner: 1,
  sampleCount: 3,
  createdAt: '2026-11-01T10:00:00.000Z',
};
const mockNotesState = {
  voiceProfiles: [mockProfile],
  loadVoiceProfiles: jest.fn(),
  enrollVoiceProfile: jest.fn(),
  reenrollVoiceProfile: jest.fn(),
  relabelMeetingSpeakers: jest.fn(),
  updateVoiceProfile: jest.fn(),
  deleteVoiceProfile: jest.fn(),
  deleteAllVoiceProfiles: jest.fn(),
  isDiarizerModelReady: jest.fn(async () => true),
  isDiarizerModelDownloading: jest.fn(() => false),
  downloadDiarizerModel: jest.fn(async () => undefined),
};
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (pick: (s: typeof mockNotesState) => unknown) => pick(mockNotesState),
}));
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));
jest.mock('@/data', () => ({ notesRepository: { getSpeakerProfiles: () => [] } }));
jest.mock('@/android/shared/data', () => jest.requireMock('@/data'));
jest.mock('@/data/local/notesRepository', () => ({
  SpeakerProfileOwnerAlreadyExistsError: class extends Error {},
}));
jest.mock('@/android/data/notesRepository', () => jest.requireMock('@/data/local/notesRepository'));
jest.mock('@/components/notes/VoiceEnrollmentRecorder', () => ({
  VoiceEnrollmentRecorder: () => null,
}));
jest.mock('@/components/notes/SectionHeader', () => ({
  SectionHeader: ({ label }: { label: string }) =>
    require('react').createElement(require('react-native').Text, null, label),
}));
jest.mock('@/components/notes/VoiceProfileList.android', () => ({
  VoiceProfileList: () => null,
}));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn(async () => undefined) }),
}));
jest.mock('@/android/shared/hooks/useSuperwallGate', () =>
  jest.requireMock('@/hooks/useSuperwallGate'),
);
jest.mock('@/android/shared/lib/voiceEnrollmentCapability', () => ({
  supportsVoiceEnrollment: () => mockSupportsEnrollment,
  VOICE_ENROLLMENT_UNAVAILABLE: 'Voice profiles are not available.',
}));
let mockSupportsEnrollment = true;
jest.mock('@/android/settings/kit', () => {
  const actual = jest.requireActual('@/android/settings/kit');
  return {
    ...actual,
    PillAction: ({ label }: { label: string }) =>
      require('react').createElement(require('react-native').Text, null, label),
  };
});

// Workflow settings: only what its first render reads.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => ({
    back: jest.fn(),
    canGoBack: () => true,
    replace: jest.fn(),
    push: jest.fn(),
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: () => undefined,
}));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: jest.fn() }),
  usePreventRemove: jest.fn(),
}));
jest.mock('@/components/ui/Toast', () => ({ Toast: () => null }));
jest.mock('@/android/shared/components/ui/Toast', () => jest.requireMock('@/components/ui/Toast'));
jest.mock('@/components/settings/OnDeviceModelSection', () => ({
  OnDeviceModelSection: () => null,
}));
jest.mock('@/android/shared/components/settings/OnDeviceModelSection', () =>
  jest.requireMock('@/components/settings/OnDeviceModelSection'),
);
jest.mock('@/hooks/useConfigToggle', () => ({ useConfigToggle: () => () => undefined }));
jest.mock('@/android/shared/hooks/useConfigToggle', () =>
  jest.requireMock('@/hooks/useConfigToggle'),
);
jest.mock('@/store/useCustomPromptsStore', () => ({
  useCustomPromptsStore: (pick: (s: unknown) => unknown) => pick({ customPrompts: {} }),
}));
jest.mock('@/android/shared/store/useCustomPromptsStore', () =>
  jest.requireMock('@/store/useCustomPromptsStore'),
);
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (pick: (s: unknown) => unknown) => pick({ user: null }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (pick: (s: unknown) => unknown) => pick({ config: null, updateConfig: jest.fn() }),
    { getState: () => ({ config: null, error: null }) },
  ),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: (pick: (s: unknown) => unknown) =>
    pick({ setActiveMode: jest.fn(), activeMode: 'cloud' }),
}));
jest.mock('@/android/shared/store/useProcessingModeStore', () =>
  jest.requireMock('@/store/useProcessingModeStore'),
);
jest.mock('@/services/providers/ProviderExecution', () => ({
  discoverProviderModels: jest.fn(),
  testProviderConnection: jest.fn(),
  ProviderExecutionError: class extends Error {},
}));
jest.mock('@/services/providers/ProviderPolicy', () => ({
  getProviderPolicy: jest.fn(() => new Promise(() => undefined)),
}));
jest.mock('@/android/shared/services/providers/ProviderPolicy', () =>
  jest.requireMock('@/services/providers/ProviderPolicy'),
);
jest.mock('@/services/providers/ProviderCredentials', () => ({
  getProviderCredentialReference: jest.fn(async () => 'provider.openai'),
  getProviderCredential: jest.fn(async () => null),
  getProviderCredentialStatus: jest.fn(() => new Promise(() => undefined)),
  setProviderCredential: jest.fn(),
  removeProviderCredential: jest.fn(),
}));
jest.mock('@/lib/privateMode', () => ({
  getPrivateModeReadiness: () => new Promise(() => undefined),
}));
jest.mock('@/android/shared/lib/privateMode', () => jest.requireMock('@/lib/privateMode'));
jest.mock('@/lib/localReasoning', () => ({
  ...jest.requireActual('@/lib/localReasoning'),
  getLocalReasoningReadiness: () => new Promise(() => undefined),
}));
jest.mock('@/android/shared/lib/localReasoning', () => jest.requireMock('@/lib/localReasoning'));
jest.mock('@/lib/workflowModeSwitch', () => ({
  switchWorkflowMode: jest.fn(),
  leavingLocalModeWithLocalReasoning: async () => false,
}));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import VoiceEnrollmentScreen from '@/screens/VoiceEnrollmentScreen.android';
import VoiceProfileDetailScreen from '@/screens/VoiceProfileDetailScreen.android';
import VoiceProfilesScreen from '@/screens/VoiceProfilesScreen.android';
import { WorkflowSettingsScreen } from '@/screens/WorkflowSettingsScreen.android';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const colorOf = (text: string) => flat(screen.getByText(text).props.style).color;

/** The nearest ancestor (or the node) with a background, i.e. the page it sits on. */
function pageBehind(text: string) {
  let node = screen.getByText(text).parent;
  while (node && !flat(node.props.style)?.backgroundColor) node = node.parent;
  return node ? flat(node.props.style).backgroundColor : undefined;
}

function renderIn(scheme: 'light' | 'dark', element: React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(
    <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 0, left: 0 }}>
      <ThemeProvider>{element}</ThemeProvider>
    </SafeAreaInsetsContext.Provider>,
  );
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockParams = {};
  mockSupportsEnrollment = true;
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('voice and workflow screens in %s', (scheme, tokens) => {
  it('teaching a voice: page and title from the palette', () => {
    mockParams = { owner: '1' };
    renderIn(scheme, <VoiceEnrollmentScreen />);
    expect(colorOf('Teach OpenWhispr Your Voice')).toBe(tokens.ink);
    expect(pageBehind('Teach OpenWhispr Your Voice')).toBe(tokens.canvas);
  });

  it('voice enrollment unavailable: canvas and secondary text', () => {
    mockSupportsEnrollment = false;
    renderIn(scheme, <VoiceEnrollmentScreen />);
    const page = flat(screen.getByTestId('voice-enrollment-unavailable').props.style);
    expect(page.backgroundColor).toBe(tokens.canvas);
    expect(colorOf('Voice profiles are not available.')).toBe(tokens.secondary);
  });

  it('a voice profile: ink, secondary, accent, error and the field colours', () => {
    mockParams = { profileId: '2' };
    renderIn(scheme, <VoiceProfileDetailScreen />);
    expect(colorOf('Alice')).toBe(tokens.ink);
    expect(colorOf('You')).toBe(tokens.secondary);
    expect(colorOf('Samples')).toBe(tokens.secondary);
    expect(colorOf('3')).toBe(tokens.ink);
    expect(colorOf('Retrain Voice')).toBe(tokens.accent);
    expect(colorOf('Delete Profile')).toBe(tokens.error);
    const email = screen.getByTestId('voice-profile-email-input');
    expect(email.props.placeholderTextColor).toBe(tokens.tertiary);
    expect(flat(email.props.style).color).toBe(tokens.ink);
    expect(pageBehind('Alice')).toBe(tokens.canvas);
    expect(pageBehind('You')).toBe(tokens.track);
  });

  it('the voice profiles list sits on the canvas', () => {
    const view = renderIn(scheme, <VoiceProfilesScreen />);
    const root = view.toJSON() as { props: { style: unknown } };
    expect(flat(root.props.style).backgroundColor).toBe(tokens.canvas);
  });

  it('workflow settings: canvas, footer text and the Save button', () => {
    mockParams = { scope: 'dictation' };
    renderIn(scheme, <WorkflowSettingsScreen />);
    fireEvent.press(screen.getByText('Bring Your Own Key'));
    expect(colorOf('Save')).toBe(tokens.onGlass);
    const footer = screen.getByText(/^Checks use the key above/);
    expect(flat(footer.props.style).color).toBe(tokens.secondary);
    expect(pageBehind('Bring Your Own Key')).toBeDefined();
    const root = screen.toJSON() as { props: { style: unknown } };
    expect(flat(root.props.style).backgroundColor).toBe(tokens.canvas);
  });

  it('an unknown workflow says so in secondary text', () => {
    mockParams = { scope: 'nope' };
    renderIn(scheme, <WorkflowSettingsScreen />);
    expect(colorOf('This workflow is not available.')).toBe(tokens.secondary);
  });
});

/** Holds state of its own, so a remount would show as a reset count. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Pressable onPress={() => setCount((n) => n + 1)}>
      <Text testID="count">{String(count)}</Text>
    </Pressable>
  );
}

it('switches a voice profile in place: typed name kept, same node, new colours', async () => {
  mockParams = { profileId: '2' };
  const tree = () => (
    <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 0, left: 0 }}>
      <ThemeProvider>
        <VoiceProfileDetailScreen />
        <Counter />
      </ThemeProvider>
    </SafeAreaInsetsContext.Provider>
  );
  const view = render(tree());
  fireEvent.press(screen.getByTestId('count'));
  fireEvent.changeText(screen.getByTestId('voice-profile-name-input'), 'Alice B');
  const input = screen.getByTestId('voice-profile-name-input');
  expect(colorOf('Alice')).toBe(lightTheme.ink);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(tree());
  });

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('count').props.children).toBe('1');
  expect(screen.getByTestId('voice-profile-name-input')).toBe(input);
  expect(screen.getByTestId('voice-profile-name-input').props.value).toBe('Alice B');
  expect(colorOf('Alice')).toBe(darkTheme.ink);
  expect(colorOf('Delete Profile')).toBe(darkTheme.error);
});
