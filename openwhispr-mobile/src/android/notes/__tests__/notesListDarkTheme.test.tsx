import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
let mockNotes: unknown[] = [];
const mockState = {
  folders: [{ id: 1, name: 'Meetings', isDefault: 1, spaceId: null }],
  isInitialized: true,
  initialize: jest.fn(),
  createFolder: jest.fn(),
  spaces: [],
  folderCounts: {},
  notes: [],
  transcriptRevision: 0,
  getSpaceFolders: () => [],
};

jest.mock('../../../../modules/android-dictation/src/themeFade', () => ({
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
// The Start sheet's model rows read the phone's models and settings; not under test here.
jest.mock('../meetingModelSheet', () => ({
  MeetingModelList: () => null,
  MeetingModelRow: () => null,
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('@react-navigation/native', () => ({ useScrollToTop: jest.fn() }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: object) =>
      require('react').createElement(View, { testID: 'page', ...props }),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('react-native-gesture-handler', () => {
  const gesture: Record<string, unknown> = {};
  for (const name of ['enabled', 'activeOffsetX', 'failOffsetY', 'onStart', 'onUpdate', 'onEnd'])
    gesture[name] = () => gesture;
  return {
    Gesture: { Pan: () => gesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Easing: { out: () => undefined, inOut: () => undefined, cubic: undefined, quad: undefined },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withDelay: (_: number, value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
jest.mock('@/store/useNotesStore', () => {
  const useNotesStore = (select?: (state: unknown) => unknown) =>
    select ? select(mockState) : mockState;
  useNotesStore.getState = () => mockState;
  return { useNotesStore };
});
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));
jest.mock('@/data', () => ({ notesRepository: { getAllNotes: () => mockNotes } }));
jest.mock('@/data/spacesRepository', () => ({
  spacesRepository: { getPrivateSpace: () => ({ id: 1 }) },
}));
jest.mock('@/hooks/useManualSyncRefresh', () => ({
  useManualSyncRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }),
}));
jest.mock('@/lib/notes/noteRouteOwner', () => ({
  withNotesRouteOwner: (params: object) => params,
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: () => false }));
jest.mock('@/android/lib/accountAccess', () => jest.requireMock('@/lib/accountAccess'));
jest.mock('@/store/useGoogleCalendarStore', () => {
  const state = { accounts: [], load: () => Promise.resolve() };
  return { useGoogleCalendarStore: (select: (s: unknown) => unknown) => select(state) };
});
jest.mock('../../calendar/connect', () => ({
  dismissCalendarPrompt: jest.fn(),
  loadCalendarPromptDismissed: jest.fn(),
  useCalendarPromptDismissed: (select: (s: unknown) => unknown) => select({ dismissed: false }),
}));
jest.mock('../../calendar/useConnectGoogle', () => ({
  useConnectGoogle: () => ({ connecting: false, connect: jest.fn(), cancel: jest.fn() }),
}));
jest.mock('../../navigationBar', () => ({ useNavigationBarCanvas: jest.fn() }));
jest.mock('../../settings/kit', () => {
  const { View } = require('react-native');
  const mockReact = require('react');
  return {
    useSettingsToast: (select: (state: unknown) => unknown) => select({ action: undefined }),
    useReduceMotion: () => false,
    showToast: jest.fn(),
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? mockReact.createElement(View, { testID: 'sheet' }, children) : null,
    TextAction: () => null,
  };
});
jest.mock('../../processingFable/look', () => ({ GlassButton: () => null }));
jest.mock('../strings', () => ({
  useNotesT: () => (key: string) => key,
  notesT: (key: string) => key,
}));
jest.mock('../calendar', () => ({
  useUpNext: () => ({ next: null, events: [], now: 0 }),
  hideUpNext: jest.fn(),
  eventIsNow: () => false,
  minutesUntil: () => 12,
  eventTimeRange: () => '',
}));
jest.mock('../meetingStart', () => ({
  useMeetingStart: () => ({ open: jest.fn(), sheet: null }),
}));
jest.mock('../folderMenu', () => ({ useFolderMenu: () => ({ open: jest.fn(), sheets: null }) }));
jest.mock('../pendingDeletes', () => ({
  useHiddenNoteIds: () => [],
  consumeRestored: () => false,
}));
jest.mock('../workspaceList', () => ({ useLoadWorkspaces: jest.fn() }));
jest.mock('@/sync/teamSpacesCapability', () => ({ getDefaultPrivateWorkspaceId: () => null }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (select: (state: unknown) => unknown) => select({ user: { id: 'u1' } }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));

import { ThemeProvider } from '../../ThemeProvider';
import { darkTheme, lightTheme } from '../../theme';
import NotesRoot from '../NotesRoot';
import { NoteRow, SwipeRow } from '../rows';
import { CalendarPrompt } from '../CalendarPrompt';
import type { Note } from '@/data';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
type ReactTestInstance = ReturnType<typeof screen.getByText>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

const note = (id: number, fields: object = {}) => ({
  id,
  title: `Note ${id}`,
  content: 'First line',
  folderId: 1,
  spaceId: null,
  leftTeam: 0,
  noteType: 'note',
  updatedAt: '2026-11-19 10:00:00',
  ...fields,
});

/** The nearest host view above `node` whose style passes `test`. */
function ancestor(node: ReactTestInstance, test: (style: Record<string, unknown>) => boolean) {
  let current: ReactTestInstance | null = node.parent;
  while (current) {
    if (typeof current.type === 'string' && test(flat(current.props.style))) return current;
    current = current.parent;
  }
  throw new Error('no matching ancestor');
}

function renderIn(scheme: 'light' | 'dark', children: React.ReactNode) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{children}</ThemeProvider>);
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockNotes = [note(1)];
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Notes list in %s', (scheme, tokens) => {
  it('draws the page and a folder row from that palette', async () => {
    renderIn(scheme, <NotesRoot />);
    await act(async () => undefined);
    expect(flat(screen.getAllByTestId('page')[0].props.style).backgroundColor).toBe(tokens.canvas);
    const folder = screen.getByText('Meetings');
    expect(flat(folder.props.style).color).toBe(tokens.ink);
    const card = ancestor(folder, (style) => style.borderRadius === 16);
    expect(card.props.style && flat(card.props.style).backgroundColor).toBe(tokens.surface);
  });

  it('draws a note row, its swipe row and its lines from that palette', () => {
    renderIn(
      scheme,
      <SwipeRow onDelete={() => undefined} onMove={() => undefined}>
        <NoteRow note={note(2) as unknown as Note} onPress={() => undefined} />
      </SwipeRow>,
    );
    const title = screen.getByText('Note 2');
    expect(flat(title.props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('First line').props.style).color).toBe(tokens.secondary);
    expect(flat(screen.getByText(/kindNote/).props.style).color).toBe(tokens.tertiary);
    const row = ancestor(title, (style) => style.paddingLeft === 14);
    expect(flat(row.props.style).backgroundColor).toBe(tokens.surface);
    expect(flat(screen.getByText('move', { includeHiddenElements: true }).props.style).color).toBe(
      tokens.ink,
    );
    expect(
      flat(screen.getByText('delete', { includeHiddenElements: true }).props.style).color,
    ).toBe(tokens.onGlass);
  });

  it('draws the calendar prompt from that palette', async () => {
    renderIn(scheme, <CalendarPrompt />);
    await act(async () => undefined);
    const title = screen.getByText('connectCalendar');
    expect(flat(title.props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('connectCalendarBody').props.style).color).toBe(tokens.secondary);
    expect(flat(screen.getByText('connectGoogle').props.style).color).toBe(tokens.onGlass);
    const card = ancestor(title, (style) => style.borderRadius === 16);
    expect(flat(card.props.style).backgroundColor).toBe(tokens.surface);
  });

  it('draws the empty Notes state from that palette', () => {
    mockNotes = [];
    renderIn(scheme, <NotesRoot />);
    expect(flat(screen.getAllByTestId('page')[0].props.style).backgroundColor).toBe(tokens.canvas);
    expect(flat(screen.getByText('tapToRecord').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('tapToRecordBody').props.style).color).toBe(tokens.secondary);
    const halo = ancestor(screen.getByLabelText('tapToRecord'), (style) => style.width === 168);
    expect(flat(halo.props.style).backgroundColor).toBe(
      scheme === 'dark' ? 'rgba(110,155,255,0.14)' : 'rgba(21,85,212,0.08)',
    );
  });
});

/** Holds state of its own, so a remount would show as a reset count. */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <Pressable onPress={() => setCount((value) => value + 1)}>
      <Text testID="count">{String(count)}</Text>
    </Pressable>
  );
}

it('switches the Notes list in place: same list, state kept, new colours', async () => {
  const tree = () => (
    <ThemeProvider>
      <NotesRoot />
      <Counter />
    </ThemeProvider>
  );
  const view = render(tree());
  await act(async () => undefined);
  fireEvent.press(screen.getByTestId('count'));
  fireEvent.press(screen.getByTestId('count'));
  const list = view.UNSAFE_getByType(ScrollView);
  const folder = screen.getByText('Meetings');
  expect(flat(folder.props.style).color).toBe(lightTheme.ink);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(tree());
  });

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('count').props.children).toBe('2');
  expect(view.UNSAFE_getByType(ScrollView)).toBe(list);
  expect(screen.getByText('Meetings')).toBe(folder);
  expect(flat(screen.getByText('Meetings').props.style).color).toBe(darkTheme.ink);
  expect(flat(screen.getAllByTestId('page')[0].props.style).backgroundColor).toBe(darkTheme.canvas);
});
