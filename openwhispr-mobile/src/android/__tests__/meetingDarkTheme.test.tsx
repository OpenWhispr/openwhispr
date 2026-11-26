import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
} from 'react-native';

/**
 * The meeting recording views follow a light/dark switch in place: the recording keeps running
 * (no restart, no stop), and the timer, live transcript, notes tab and Stop keep their state.
 */
const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { getMeetingLevel: () => 0.9 },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, SvgXml: View, Circle: View };
});
jest.mock('@/android/notes/noteChips', () => ({ RecordingNoteChips: () => null }));
jest.mock('@/android/navigationBar', () => ({
  useNavigationBarCanvas: jest.fn(),
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
}));

const mockCreateNote = jest.fn(() => ({ id: 7, content: '' }));
const mockFinalize = jest.fn(async () => undefined);
const mockReplace = jest.fn();
const mockLocalStart = jest.fn(async (): Promise<void> => undefined);
const mockCancelLocal = jest.fn(async () => undefined);
const mockStopCloud = jest.fn();
const mockCancelCloud = jest.fn(async (): Promise<void> => undefined);
const mockRealtimeStart = jest.fn();
let mockUseRealCloudHook = false;
const mockParts = [{ itemId: 'kept', text: 'Captured meeting text.', startMs: 0, endMs: 1000 }];
const mockNotes = {
  createMeetingNote: mockCreateNote,
  finalizeCloudMeeting: mockFinalize,
  updateNote: jest.fn(),
  transitionStatus: jest.fn(),
  runMeetingPipeline: jest.fn(),
  isDiarizerAvailable: jest.fn(async () => true),
  isLocalAsrModelReady: jest.fn(async () => true),
  isDiarizerModelReady: jest.fn(async () => true),
  downloadDiarizerModel: jest.fn(),
  notes: [{ id: 7, transcriptionStatus: 'recording' }],
};
const mockLoadCalendars = jest.fn(async () => undefined);
const mockAccounts: unknown[] = [];
let mockUser = { id: 'a' };
let mockMode = 'cloud';
let mockAudioNamespace = '';
// No key saved for meetings: OpenWhispr Cloud connects.
jest.mock('@/android/providers/liveMeeting', () => ({ liveMeetingDeps: () => ({}) }));
jest.mock('@/android/accountData', () => ({
  useAccountData: {
    getState: () => ({
      owner: 'account:a',
      audioNamespace: mockAudioNamespace,
      revision: 1,
      error: null,
      blocked: false,
    }),
  },
}));
let mockFeature: (() => void) | undefined;
let mockBlur: (() => void) | undefined;
let mockFocus: (() => () => void) | undefined;
let mockAuthListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockModeListener: ((state: unknown, previous: unknown) => void) | undefined;
let mockParams = { folderId: '2' };

const mockCancelDownload = jest.fn(async (_id: string) => undefined);
jest.mock('@/android/models', () => ({
  cancelAndroidDownload: (id: string) => mockCancelDownload(id),
}));
const mockDurableStart = jest.fn(async (): Promise<void> => undefined);
const mockDurableStop = jest.fn(async () => 'file:///app/documents/meeting-7.wav');
let mockOwnerValid = true;
let mockUseRealLocalContext = false;
const mockAuthListeners = new Set<(state: unknown, previous: unknown) => void>();
let mockSavedNote = {
  id: 7,
  clientNoteId: 'local-a7',
  createdAt: '2026-10-23 13:00:00',
  noteType: 'meeting',
  isPrivate: 1,
  deletedAt: null,
  sourceFile: 'file:///app/documents/meeting-7.wav',
  transcriptionStatus: 'recording',
};
jest.mock('@/android/LocalMeetingRecorder', () => ({
  LocalMeetingRecorder: jest.fn().mockImplementation(() => {
    return {
      uri: 'file:///app/documents/meeting-7.wav',
      start: mockDurableStart,
      stop: mockDurableStop,
    };
  }),
}));
jest.mock('@/android/localMeetingContext', () => ({
  createLocalMeetingContext: (_id: number, signal: AbortSignal = new AbortController().signal) =>
    mockUseRealLocalContext
      ? jest.requireActual('@/android/localMeetingContext').createLocalMeetingContext(_id, signal)
      : {
          signal,
          ownsNote: () => mockOwnerValid,
          ownsSavedNote: () => mockOwnerValid,
          recoverInterruptedNoteWhenOwnerReturns: jest.fn(),
          checkpoint: () => {
            if (!mockOwnerValid || signal.aborted)
              throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          },
          dispose: jest.fn(),
        },
}));

jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockReplace(...args),
    back: jest.fn(),
    canGoBack: () => true,
  },
  useNavigation: () => ({ setOptions: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => () => void) => {
    require('react').useEffect(() => {
      mockFocus = callback;
      mockBlur = callback();
      return mockBlur;
    }, [callback]);
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
jest.mock('@react-navigation/native', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/documents/' }));
jest.mock('@/lib/meetingAudioStorage', () =>
  jest.requireActual('@/lib/meetingAudioStorage.android'),
);
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/Button', () => ({ Button: require('react-native').Pressable }));
jest.mock('@/components/features/WaveformVisualizer', () => ({ ProcessingWaveform: () => null }));
jest.mock('@/components/notes/CalendarEventPicker', () => ({ CalendarEventPicker: () => null }));
jest.mock('@/components/notes/SpeakerCountPrompt', () => ({
  SpeakerCountPrompt: ({ onSubmit }: { onSubmit: () => void }) =>
    require('react').createElement(require('react-native').Pressable, {
      testID: 'begin',
      onPress: onSubmit,
    }),
}));
jest.mock('@/android/MeetingSetup', () => ({
  MeetingSetup: ({ onStart, busy }: { onStart: () => void; busy: boolean }) =>
    require('react').createElement(require('react-native').Pressable, {
      testID: 'begin',
      onPress: onStart,
      disabled: busy,
    }),
}));
jest.mock('@/config/colors', () => ({ BRAND: '#222', iosColor: () => '#222' }));
jest.mock('@/data', () => ({
  notesRepository: {
    updateNoteMeta: jest.fn(),
    getNoteById: () => mockSavedNote,
  },
}));
jest.mock('@/data/calendarRepository', () => ({ calendarRepository: {} }));
jest.mock('@/lib/calendar/meetingContext', () => ({ buildCalendarMeetingContext: jest.fn() }));
jest.mock('@/lib/calendar/meetingSuggestions', () => ({
  getMeetingCalendarEventSuggestions: () => [],
}));
jest.mock('@/lib/transcriptionLanguage', () => ({ getPreferredTranscriptionLanguage: () => 'en' }));
jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({ startRecording: mockLocalStart, cancelRecording: mockCancelLocal }),
}));
jest.mock('@/android/hooks/useAudioRecording', () => jest.requireMock('@/hooks/useAudioRecording'));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/hooks/useMeetingLiveActivity', () => ({ useMeetingLiveActivity: jest.fn() }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({
    register: async ({ feature }: { feature: () => void }) => {
      mockFeature = feature;
    },
  }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: Object.assign((select: (s: typeof mockNotes) => unknown) => select(mockNotes), {
    getState: () => mockNotes,
  }),
}));
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: (select: (s: unknown) => unknown) =>
    select({ accounts: mockAccounts, load: mockLoadCalendars }),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: mockUser }),
    subscribe: (listener: typeof mockAuthListener) => {
      if (listener) mockAuthListeners.add(listener);
      mockAuthListener = (state, previous) => {
        for (const callback of mockAuthListeners) callback(state, previous);
      };
      return () => {
        if (listener) mockAuthListeners.delete(listener);
      };
    },
  },
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: mockMode }),
    subscribe: (listener: typeof mockModeListener) => {
      mockModeListener = listener;
      return jest.fn();
    },
  },
}));
jest.mock('@/lib/accountAccess', () => ({
  canRunCloudMeeting: (_user: unknown, mode: string) => mode === 'cloud',
}));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('@/lib/superwall', () => ({ SUPERWALL_PLACEMENTS: { meetingRecordStart: 'meeting' } }));
jest.mock('@/android/RealtimeMeetingWsService', () => ({
  startRealtimeMeetingWs: (...args: unknown[]) => mockRealtimeStart(...args),
}));
jest.mock('@/android/useCloudMeeting', () => ({
  ...jest.requireActual('@/android/useCloudMeeting'),
  useCloudMeeting: (options: unknown) =>
    mockUseRealCloudHook
      ? jest.requireActual('@/android/useCloudMeeting').useCloudMeeting(options)
      : {
          stop: mockStopCloud,
          cancel: mockCancelCloud,
          elapsedSeconds: 2,
          status: 'live',
          utterances: mockParts,
          stopRequested: false,
        },
}));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { RecordingView } from '../notes/RecordingView';
import { CloudFinishCard } from '../notes/cloudFinish';
import { LiveTranscriptListView } from '@/components/notes/LiveTranscriptListView.android';
import { CloudMeetingScreen } from '../CloudMeetingScreen';
import { useCloudFinish } from '../notes/cloudFinishStore';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const hidden = { includeHiddenElements: true };
type Node = { props: { style?: unknown }; parent: Node | null };
/** The nearest view at or above `node` that paints a background, and its colour. */
function paintedAncestor(node: Node | null): Node {
  let at = node;
  while (at && !flat(at.props.style)?.backgroundColor) at = at.parent;
  if (!at) throw new Error('nothing paints behind this node');
  return at;
}
const backgroundOf = (node: unknown) =>
  flat(paintedAncestor(node as Node).props.style).backgroundColor;
/** The outermost painted view: the recording page. */
function pageOf(node: unknown): Node {
  let page = paintedAncestor(node as Node);
  for (let at = page.parent; at; at = at.parent)
    if (flat(at.props.style)?.backgroundColor) page = at;
  return page;
}

/** Counts its own mounts and unmounts, the way a recorder started on mount would. */
const life = { mounts: 0, unmounts: 0 };
function Transcript() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    life.mounts += 1;
    return () => {
      life.unmounts += 1;
    };
  }, []);
  return (
    <Text testID="ticks" onPress={() => setTicks((n) => n + 1)}>
      {String(ticks)}
    </Text>
  );
}

function Recording({ withTranscript = true }: { withTranscript?: boolean }) {
  const [notes, setNotes] = useState('');
  return (
    <RecordingView
      status="live"
      elapsedSeconds={65}
      title="Weekly sync"
      chips={['Today']}
      rawNotes={notes}
      onChangeRawNotes={setNotes}
      transcript={withTranscript ? <Transcript /> : null}
      onStop={jest.fn()}
      keyboardHeight={0}
    />
  );
}

const inTheme = (children: React.ReactNode) => <ThemeProvider>{children}</ThemeProvider>;

async function switchTo(view: ReturnType<typeof render>, node: React.ReactNode, scheme: 'dark') {
  mockScheme.mockReturnValue(scheme);
  await act(async () => {
    view.rerender(inTheme(node));
  });
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  life.mounts = 0;
  life.unmounts = 0;
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('meeting recording in %s', (scheme, k) => {
  beforeEach(() => mockScheme.mockReturnValue(scheme));

  it('draws the page, pill, card, waveform and Stop from that palette', () => {
    render(inTheme(<Recording withTranscript={false} />));
    const pill = screen.getByText('recording');
    expect(flat(pill.props.style).color).toBe(k.ink);
    expect(flat(screen.getByText('Weekly sync').props.style).color).toBe(k.ink);
    const notes = screen.getByTestId('meeting-raw-notes');
    expect(notes.props.placeholderTextColor).toBe(k.tertiary);
    expect(flat(notes.props.style).color).toBe(k.ink);
    expect(backgroundOf(notes)).toBe(k.surface);
    expect(flat(pageOf(notes).props.style).backgroundColor).toBe(k.canvas);
    const waveform = screen.getByTestId('meeting-waveform', hidden);
    fireEvent(waveform, 'layout', { nativeEvent: { layout: { width: 57, height: 18 } } });
    const bars = screen.getByTestId('meeting-waveform-bars', hidden).children as {
      props: { style: { backgroundColor: string } };
    }[];
    expect(bars[0].props.style.backgroundColor).toBe(k.accent);
    const stop = screen.getByTestId('meeting-stop');
    expect(flat(stop.props.style).experimental_backgroundImage).toBe(
      'linear-gradient(180deg, #5588F0 0%, #3466E2 100%)',
    );
    expect(flat(screen.getByText('stopAndSave').props.style).color).toBe(k.onGlass);
  });

  it('draws the live transcript lines and the finish card from that palette', () => {
    render(
      inTheme(
        <>
          <LiveTranscriptListView
            utterances={[{ itemId: 'a', text: 'Ship it on Friday.' } as never]}
            partialText="and then"
            active
          />
          <CloudFinishCard stage="finishing" transcriptDone={false} />
        </>,
      ),
    );
    expect(flat(screen.getByText('Ship it on Friday.').props.style).color).toBe(k.ink);
    expect(flat(screen.getByText('and then').props.style).color).toBe(k.tertiary);
    expect(flat(screen.getByTestId('cloud-finish').props.style).backgroundColor).toBe(k.surface);
  });
});

it('switches a live recording to dark in place: no remount, state and timer kept', async () => {
  const view = render(inTheme(<Recording />));
  fireEvent.press(screen.getByTestId('ticks'));
  fireEvent.press(screen.getByTestId('ticks'));
  const stop = screen.getByTestId('meeting-stop');
  const pill = screen.getByText('recording');
  expect(life).toEqual({ mounts: 1, unmounts: 0 });

  await switchTo(view, <Recording />, 'dark');

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  // The transcript (where a recorder or live socket would live) was never remounted.
  expect(life).toEqual({ mounts: 1, unmounts: 0 });
  expect(screen.getByTestId('ticks').props.children).toBe('2');
  expect(screen.getByTestId('meeting-stop')).toBe(stop);
  expect(screen.getByText('recording')).toBe(pill);
  expect(flat(pill.props.style).color).toBe(darkTheme.ink);
  expect(backgroundOf(screen.getByTestId('ticks'))).toBe(darkTheme.surface);
  expect(flat(pageOf(stop).props.style).backgroundColor).toBe(darkTheme.canvas);
});

it('keeps the picked tab and typed notes across a switch', async () => {
  const view = render(inTheme(<Recording />));
  fireEvent.press(screen.getByText('myNotes'));
  fireEvent.changeText(screen.getByTestId('meeting-raw-notes'), 'Ask about budget');
  const field = screen.getByTestId('meeting-raw-notes');
  // Leaving the transcript tab unmounts it; the switch itself must not mount or unmount anything.
  expect(life).toEqual({ mounts: 1, unmounts: 1 });

  await switchTo(view, <Recording />, 'dark');

  expect(screen.getByTestId('meeting-raw-notes')).toBe(field);
  expect(field.props.value).toBe('Ask about budget');
  expect(field.props.placeholderTextColor).toBe(darkTheme.tertiary);
  expect(life).toEqual({ mounts: 1, unmounts: 1 });
});

describe('Cloud meeting screen', () => {
  beforeEach(() => {
    useCloudFinish.setState({ jobs: {} });
    Platform.OS = 'android';
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    mockUseRealCloudHook = true;
    mockFeature = undefined;
  });
  afterEach(() => {
    mockUseRealCloudHook = false;
    jest.restoreAllMocks();
  });

  it('keeps the live meeting running through a switch to dark: one start, no stop', async () => {
    const session = { stop: jest.fn(), finish: jest.fn(), utterances: () => mockParts };
    mockRealtimeStart.mockReset().mockResolvedValue(session);
    const view = render(inTheme(<CloudMeetingScreen />));
    await act(async () => fireEvent.press(view.getByTestId('begin')));
    await act(async () => mockFeature?.());
    expect(mockRealtimeStart).toHaveBeenCalledTimes(1);
    const stop = screen.getByTestId('meeting-stop');
    const page = pageOf(stop);
    expect(flat(page.props.style).backgroundColor).toBe(lightTheme.canvas);

    await switchTo(view, <CloudMeetingScreen />, 'dark');

    expect(mockRealtimeStart).toHaveBeenCalledTimes(1);
    expect(session.stop).not.toHaveBeenCalled();
    expect(session.finish).not.toHaveBeenCalled();
    expect(mockCancelCloud).not.toHaveBeenCalled();
    expect(mockCreateNote).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('meeting-stop')).toBe(stop);
    expect(pageOf(stop)).toBe(page);
    expect(flat(page.props.style).backgroundColor).toBe(darkTheme.canvas);
  });
});
