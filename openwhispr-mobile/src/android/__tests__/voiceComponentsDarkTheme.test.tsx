import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, Text, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ mdName, color }: { mdName: string; color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID={`glyph-${mdName}`} accessibilityHint={color} />;
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: number) => value,
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: { children: React.ReactNode }) => children,
}));
// Jest resolves the iOS files by default; the voice list uses the Android ones on a device.
jest.mock('@/components/notes/GroupedList', () =>
  jest.requireActual('@/components/notes/GroupedList.android'),
);
jest.mock('@/components/notes/SectionHeader', () =>
  jest.requireActual('@/components/notes/SectionHeader.android'),
);

// The recorder's audio, files and model checks.
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    audioRecorder: { uri: null, isRecording: false },
    isRecording: false,
    startRecording: jest.fn(async () => undefined),
    stopRecordingRaw: jest.fn(async () => null),
    cancelRecording: jest.fn(),
  }),
}));
jest.mock('@/android/hooks/useAudioRecording', () => jest.requireMock('@/hooks/useAudioRecording'));
jest.mock('@/hooks/useAudioWaveform', () => ({
  useAudioWaveform: () => ({ currentAmplitude: 0, waveformData: [] }),
}));
jest.mock('@/components/features/WaveformVisualizer', () => ({ WaveformVisualizer: () => null }));
jest.mock('react-native-svg', () => {
  const { View: Mark } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => children,
    Circle: ({ stroke }: { stroke: string }) => <Mark testID="ring" accessibilityHint={stroke} />,
  };
});
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => undefined) }));
jest.mock('@/data/local/notesRepository', () => ({
  SpeakerProfileOwnerAlreadyExistsError: class extends Error {},
}));
jest.mock('@/android/data/notesRepository', () => jest.requireMock('@/data/local/notesRepository'));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { GroupedList } from '@/components/notes/GroupedList.android';
import { SectionHeader } from '@/components/notes/SectionHeader.android';
import { VoiceProfileList } from '@/components/notes/VoiceProfileList.android';
import { VoiceEnrollmentRecorder } from '@/components/notes/VoiceEnrollmentRecorder.android';
import type { SpeakerProfile } from '@/data/types';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
const colorOf = (text: string) => flat(screen.getByText(text).props.style).color;
const hintOf = (testID: string) => screen.getAllByTestId(testID)[0].props.accessibilityHint;

/** The nearest ancestor of [text] with a visible background. */
function fillBehind(text: string | RegExp) {
  const filled = (style: unknown) => {
    const fill = flat(style).backgroundColor;
    return fill && fill !== 'transparent';
  };
  let node = screen.getByText(text).parent;
  while (node && !filled(node.props.style)) node = node.parent;
  return node ? flat(node.props.style).backgroundColor : undefined;
}

const profile = {
  id: 7,
  displayName: 'Alice',
  email: null,
  isOwner: 1,
  embedding: [1, 0],
  sampleCount: 3,
  consentAt: '2026-11-01T10:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: null,
} as unknown as SpeakerProfile;

const listProps = {
  onEnrollOwner: jest.fn(),
  onEnrollSpeaker: jest.fn(),
  onOpenProfile: jest.fn(),
  onDelete: jest.fn(),
  onDeleteAll: jest.fn(),
};

const recorderProps = {
  isOwner: false,
  isModelReady: async () => true,
  isModelDownloading: () => false,
  downloadModel: async () => undefined,
  onSubmit: async () => undefined,
  onDone: jest.fn(),
  onCancel: jest.fn(),
};

function renderIn(scheme: 'light' | 'dark', element: React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{element}</ThemeProvider>);
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('voice components in %s', (scheme, tokens) => {
  it('grouped list: card, divider and row text from the palette', () => {
    renderIn(
      scheme,
      <GroupedList>
        <GroupedList.Row>
          <Text>First</Text>
        </GroupedList.Row>
        <GroupedList.Row>
          <Text>Second</Text>
        </GroupedList.Row>
      </GroupedList>,
    );
    expect(fillBehind('First')).toBe(tokens.surface);
    const dividers = screen.UNSAFE_root.findAll(
      (node: { type: unknown; props: { style?: unknown } }) =>
        node.type === 'View' && flat(node.props.style).height === 1,
    );
    expect(dividers).toHaveLength(1);
    expect(flat(dividers[0].props.style).backgroundColor).toBe(tokens.divider);
  });

  it('section header: label and chevron in the secondary ink', () => {
    renderIn(scheme, <SectionHeader label="Speakers" collapsible />);
    expect(colorOf('Speakers')).toBe(tokens.secondary);
    expect(hintOf('glyph-ChevronDown')).toBe(tokens.secondary);
  });

  it('voice profiles: rows, badge, links and destructive row', () => {
    renderIn(scheme, <VoiceProfileList {...listProps} profiles={[profile]} />);
    expect(colorOf('Speakers')).toBe(tokens.secondary);
    expect(colorOf('Alice')).toBe(tokens.ink);
    expect(fillBehind('Alice')).toBe(tokens.surface);
    expect(fillBehind('You')).toBe(tokens.track);
    expect(colorOf('You')).toBe(tokens.secondary);
    expect(fillBehind('Speakers')).toBeUndefined();
    expect(colorOf("Add Someone's Voice")).toBe(tokens.accent);
    expect(hintOf('glyph-Plus')).toBe(tokens.accent);
    expect(hintOf('glyph-ChevronRight')).toBe(tokens.tertiary);
    expect(colorOf('Delete All Profiles')).toBe(tokens.error);
  });

  it('voice profiles empty: title, body and icon', () => {
    renderIn(scheme, <VoiceProfileList {...listProps} profiles={[]} />);
    expect(colorOf('Label speakers automatically')).toBe(tokens.ink);
    expect(hintOf('glyph-AudioLines')).toBe(tokens.disabled);
    expect(colorOf('Teach Your Voice')).toBe(tokens.onGlass);
    expect(fillBehind('Label speakers automatically')).toBe(tokens.surface);
  });

  it('recorder: script card, name field, ring and hints from the palette', async () => {
    renderIn(scheme, <VoiceEnrollmentRecorder {...recorderProps} />);
    const field = await screen.findByTestId('voice-enrollment-name');
    expect(flat(field.props.style).backgroundColor).toBe(tokens.surface);
    expect(flat(field.props.style).color).toBe(tokens.ink);
    expect(field.props.placeholderTextColor).toBe(tokens.tertiary);
    expect(fillBehind(/^I'm teaching OpenWhispr my voice/)).toBe(tokens.surface);
    expect(colorOf('Tap to start reading')).toBe(tokens.tertiary);
    expect(hintOf('ring')).toBe(tokens.accent);
    expect(hintOf('glyph-Mic')).toBe(tokens.onGlass);
  });

  it('recorder: the download ask', async () => {
    renderIn(
      scheme,
      <VoiceEnrollmentRecorder {...recorderProps} isModelReady={async () => false} />,
    );
    await waitFor(() => expect(screen.getByText('Download the speaker model')).toBeTruthy());
    expect(colorOf('Download the speaker model')).toBe(tokens.ink);
    expect(colorOf('Download')).toBe(tokens.onGlass);
    expect(colorOf('Not Now')).toBe(tokens.ink);
  });
});

it('switches the recorder and voice list in place: typed name and nodes kept', async () => {
  const tree = () => (
    <ThemeProvider>
      <VoiceProfileList {...listProps} profiles={[profile]} />
      <VoiceEnrollmentRecorder {...recorderProps} />
    </ThemeProvider>
  );
  const view = render(tree());
  const field = await screen.findByTestId('voice-enrollment-name');
  fireEvent.changeText(field, 'Sam');
  const row = screen.getByTestId('voice-profile-row-7');
  expect(colorOf('Alice')).toBe(lightTheme.ink);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(tree());
  });

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('voice-enrollment-name')).toBe(field);
  expect(screen.getByTestId('voice-enrollment-name').props.value).toBe('Sam');
  expect(screen.getByTestId('voice-profile-row-7')).toBe(row);
  expect(colorOf('Alice')).toBe(darkTheme.ink);
  expect(flat(field.props.style).backgroundColor).toBe(darkTheme.surface);
  expect(hintOf('ring')).toBe(darkTheme.accent);
});
