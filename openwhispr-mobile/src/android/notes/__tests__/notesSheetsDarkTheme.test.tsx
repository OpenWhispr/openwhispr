import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
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
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
// The Start sheet's model rows read the phone's models and settings; not under test here.
jest.mock('../meetingModelSheet', () => ({
  MeetingModelList: () => null,
  MeetingModelRow: () => null,
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), canGoBack: () => false } }));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  GestureHandlerRootView: require('react-native').View,
}));
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: () => ({ dragGesture: {}, sheetStyle: {} }),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaView: require('react-native').View,
}));
jest.mock('expo-video', () => ({ useVideoPlayer: jest.fn(), VideoView: () => null }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (pick: (s: object) => unknown) => pick({ user: null, isGuest: true }),
}));
jest.mock('react-native-svg', () => ({ SvgXml: () => null }));
jest.mock('../calendar', () => ({
  eventTimeRange: () => '10:00–10:30',
  eventIsNow: () => false,
  minutesUntil: () => 5,
}));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('../strings', () => ({
  useNotesT: () => (key: string) => key,
  notesT: (key: string) => key,
}));
jest.mock('../library', () => ({ workspacesOf: () => [] }));
jest.mock('@/store/useNotesStore', () => {
  const state = {
    spaces: [{ id: 1, kind: 'private', name: 'Private' }],
    folders: [{ id: 7, name: 'Roadmap' }],
    spaceFolders: {},
    getSpaceFolders: () => [],
    folderCounts: { 7: 3 },
    createFolder: jest.fn(),
  };
  const useNotesStore = (pick: (s: typeof state) => unknown) => pick(state);
  useNotesStore.getState = () => state;
  return { useNotesStore };
});

import { ThemeProvider } from '../../ThemeProvider';
import { darkTheme, lightTheme } from '../../theme';
import { EventSheet, PeopleSheet } from '../chipSheets';
import { MoveToFolderSheet } from '../moveSheet';
import { NoteMenuSheet, TemplateSheet } from '../noteSheets';
import { FolderNameSheet, NewSheet } from '../sheets';
import type { Note } from '@/data/types';
import type { CalendarParticipant } from '@/data/calendarTypes';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const noop = () => undefined;

const people = [
  { displayName: 'Sam Lee', email: 'sam@example.com' },
] as unknown as CalendarParticipant[];
const note = { id: 1, spaceId: 1, folderId: 7 } as unknown as Note;

/** One of each file's sheets, the way a note opens them. */
function Sheets({ which }: { which: string }) {
  switch (which) {
    case 'people':
      return (
        <PeopleSheet
          visible
          onClose={noop}
          people={people}
          viewer={{ initials: 'JP' }}
          candidates={[]}
          workspace={[]}
          viewerEmail={null}
          onQueryChange={noop}
          onRemove={noop}
          onAdd={noop}
          startAdding
        />
      );
    case 'event':
      return (
        <EventSheet
          visible
          onClose={noop}
          linked={false}
          event={null}
          events={[]}
          noteDate={new Date()}
          onJoin={noop}
          onOpen={noop}
          onPick={noop}
          onUnlink={noop}
        />
      );
    case 'move':
      return <MoveToFolderSheet visible note={note} onClose={noop} />;
    case 'template':
      return (
        <TemplateSheet
          visible
          onClose={noop}
          current="summary"
          actions={[]}
          hasSummary
          onPick={noop}
        />
      );
    case 'menu':
      return (
        <NoteMenuSheet
          visible
          onClose={noop}
          title="Standup"
          folderName="Roadmap"
          backedUp
          canBackUp
          hasSummary
          onShare={noop}
          onExport={noop}
          onCopySummary={noop}
          onMove={noop}
          onBackUp={noop}
          onDelete={noop}
        />
      );
    case 'new':
      return (
        <NewSheet
          visible
          onClose={noop}
          onRecord={noop}
          onRecordEvent={noop}
          onWrite={noop}
          onUpload={noop}
          nextEvent={null}
          now={Date.now()}
        />
      );
    default:
      return (
        <FolderNameSheet
          visible
          onClose={noop}
          title="newFolder"
          submitLabel="create"
          onSubmit={noop}
        />
      );
  }
}

function renderIn(scheme: 'light' | 'dark', which: string) {
  mockScheme.mockReturnValue(scheme);
  return render(
    <ThemeProvider>
      <Sheets which={which} />
    </ThemeProvider>,
  );
}

/** Every glyph is one of the palette's inks or the accent, never a stray light colour. */
function expectGlyphsFrom(tokens: typeof lightTheme | typeof darkTheme) {
  const allowed = [tokens.ink, tokens.secondary, tokens.tertiary, tokens.accent, tokens.error];
  for (const glyph of screen.queryAllByTestId('glyph'))
    expect(allowed).toContain(glyph.props.accessibilityHint);
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Notes sheets in %s', (scheme, tokens) => {
  it('People: field, ink and placeholder from the palette', () => {
    renderIn(scheme, 'people');
    const field = screen.getByLabelText('nameOrEmail');
    expect(flat(field.props.style).color).toBe(tokens.ink);
    expect(field.props.placeholderTextColor).toBe(tokens.tertiary);
    expectGlyphsFrom(tokens);
  });

  it('Event picker: the empty line reads in secondary', () => {
    renderIn(scheme, 'event');
    expect(flat(screen.getByText('noEventsThatDay').props.style).color).toBe(tokens.secondary);
  });

  it('Move: folder rows in ink, counts in secondary', () => {
    renderIn(scheme, 'move');
    expect(flat(screen.getByText('Roadmap').props.style).color).toBe(tokens.ink);
    expectGlyphsFrom(tokens);
  });

  it('Templates and the ⋯ menu: ink rows, palette glyphs', () => {
    renderIn(scheme, 'template');
    expect(flat(screen.getByText('templatesFooter').props.style).color).toBe(tokens.secondary);
    screen.unmount();
    renderIn(scheme, 'menu');
    expect(flat(screen.getByText('backUpNote').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('Roadmap').props.style).color).toBe(tokens.secondary);
    expectGlyphsFrom(tokens);
  });

  it('New and folder name: ink titles, themed field', () => {
    renderIn(scheme, 'new');
    expect(flat(screen.getByText('writeNote').props.style).color).toBe(tokens.ink);
    expect(flat(screen.getByText('writeNoteBody').props.style).color).toBe(tokens.secondary);
    screen.unmount();
    renderIn(scheme, 'folder');
    const field = screen.getByPlaceholderText('newFolder');
    const style = flat(field.props.style);
    expect(style.color).toBe(tokens.ink);
    expect(style.borderColor).toBe(tokens.fieldHairline);
    expect(field.props.placeholderTextColor).toBe(tokens.tertiary);
  });
});

it('switches an open sheet in place: typed text and picks kept, new colours', async () => {
  const view = renderIn('light', 'people');
  fireEvent.changeText(screen.getByLabelText('nameOrEmail'), 'sam@exa');
  const fieldBefore = screen.getByLabelText('nameOrEmail');
  expect(flat(fieldBefore.props.style).color).toBe(lightTheme.ink);

  mockScheme.mockReturnValue('dark');
  await act(async () => {
    view.rerender(
      <ThemeProvider>
        <Sheets which="people" />
      </ThemeProvider>,
    );
  });

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  const field = screen.getByLabelText('nameOrEmail');
  expect(field).toBe(fieldBefore);
  expect(field.props.value).toBe('sam@exa');
  expect(flat(field.props.style).color).toBe(darkTheme.ink);
  expect(field.props.placeholderTextColor).toBe(darkTheme.tertiary);
});
