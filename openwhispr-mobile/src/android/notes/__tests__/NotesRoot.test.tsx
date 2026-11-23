import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockOpenMeeting = jest.fn();
let mockNotes: unknown[] = [];
let mockSpaces: unknown[] = [];
let mockUpNext: { next: unknown; events: unknown[]; now: number } = {
  next: null,
  events: [],
  now: 0,
};
const mockState = {
  folders: [{ id: 1, name: 'Meetings', isDefault: 1, spaceId: null }],
  isInitialized: true,
  initialize: jest.fn(),
  createFolder: jest.fn(),
  get spaces() {
    return mockSpaces;
  },
  folderCounts: {},
  notes: [],
  transcriptRevision: 0,
  getSpaceFolders: (spaceId: number) =>
    spaceId === 9 ? [{ id: 20, name: 'Reviews', isDefault: 0, spaceId: 9 }] : [],
};

jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('@react-navigation/native', () => ({ useScrollToTop: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useNotesStore', () => {
  const useNotesStore = (select?: (state: unknown) => unknown) =>
    select ? select(mockState) : mockState;
  useNotesStore.getState = () => mockState;
  return { useNotesStore };
});
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
jest.mock('../../home/kit', () => ({
  // Settings' look reads these at import time.
  glassEdge: { borderColor: 'rgba(0,0,0,0.06)', boxShadow: 'none' },
  TILE_FILL: '#F1F1F0',
  type: { section: {} },
  home: { text: '#000', secondary: '#666', tertiary: '#999', accent: '#15d', surface: '#fff' },
  gloss: {},
  glossPressed: {},
}));
jest.mock('../../navigationBar', () => ({ useNavigationBarCanvas: jest.fn() }));
jest.mock('../../settings/kit', () => {
  const { View } = require('react-native');
  const mockReact = require('react');
  return {
    useSettingsToast: (select: (state: unknown) => unknown) => select({ action: undefined }),
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? mockReact.createElement(View, { testID: 'sheet' }, children) : null,
    TextAction: () => null,
  };
});
jest.mock('../../processingFable/look', () => ({ GlassButton: () => null }));
jest.mock('../strings', () => ({
  useNotesT: () => (key: string, options?: { count?: number }) =>
    options?.count != null ? `${key}:${options.count}` : key,
  notesT: (key: string) => key,
}));
jest.mock('../calendar', () => ({
  useUpNext: () => mockUpNext,
  hideUpNext: jest.fn(),
  eventIsNow: () => false,
  minutesUntil: () => 12,
  eventTimeRange: () => '',
}));
jest.mock('../meetingStart', () => ({
  useMeetingStart: () => ({ open: mockOpenMeeting, sheet: null }),
}));
jest.mock('../folderMenu', () => ({ useFolderMenu: () => ({ open: jest.fn(), sheets: null }) }));
jest.mock('../pendingDeletes', () => ({ useHiddenNoteIds: () => [] }));
jest.mock('../rows', () => ({ dayOf: () => 'today', timeOf: () => '10:00' }));
jest.mock('../CalendarPrompt', () => ({ CalendarPrompt: () => null }));

import NotesRoot from '../NotesRoot';
import { useNotesWorkspace } from '../library';

const note = (id: number, fields: object = {}) => ({
  id,
  title: `Note ${id}`,
  content: '',
  folderId: 1,
  spaceId: null,
  leftTeam: 0,
  updatedAt: '2026-11-19 10:00:00',
  ...fields,
});
const event = {
  id: 5,
  summary: 'Weekly sync',
  startAt: '2026-11-19T10:00:00Z',
  endAt: '2026-11-19T10:30:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNotes = [note(1)];
  mockSpaces = [];
  mockUpNext = { next: null, events: [], now: 0 };
  act(() => useNotesWorkspace.setState({ workspaceId: undefined }));
});

it('L2: with no notes, one big mic records a meeting and two links do the rest', () => {
  mockNotes = [];
  const view = render(<NotesRoot />);
  expect(view.getByText('tapToRecord')).toBeTruthy();
  fireEvent.press(view.getByLabelText('tapToRecord'));
  expect(mockOpenMeeting).toHaveBeenCalledWith(undefined);
  expect(view.queryByLabelText('search')).toBeNull();
  expect(view.queryByLabelText('new')).toBeNull();
});

it('W1: Private folders and search, no Recent, no switcher without a teamspace', () => {
  const view = render(<NotesRoot />);
  expect(view.queryByText('recent')).toBeNull();
  expect(view.getByText('Meetings')).toBeTruthy();
  expect(view.queryByLabelText('workspace')).toBeNull();
  fireEvent.press(view.getByText('Meetings'));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/(tabs)/(notes)/notes',
    params: { folderId: '1' },
  });
});

const workspaceSpaces = [
  {
    id: 9,
    kind: 'team',
    name: 'Design',
    emoji: '🎨',
    workspaceId: 'w1',
    workspaceName: 'OpenWhispr',
  },
  {
    id: 10,
    kind: 'team',
    name: 'Engineering',
    emoji: null,
    workspaceId: 'w1',
    workspaceName: 'OpenWhispr',
  },
  {
    id: 11,
    kind: 'team',
    name: 'Contracts',
    emoji: null,
    workspaceId: 'w2',
    workspaceName: 'Acme Legal',
  },
];

it('W1: one heading with the workspace’s name and one card of its teamspaces, with note counts', () => {
  mockSpaces = workspaceSpaces.slice(0, 2);
  mockNotes = [
    note(1),
    note(2, { folderId: 20, spaceId: 9 }),
    note(3, { folderId: null, spaceId: 9 }),
    note(4, { folderId: null, spaceId: 10 }),
  ];
  const view = render(<NotesRoot />);
  expect(view.getByText('PRIVATE')).toBeTruthy();
  expect(view.getByText('OPENWHISPR')).toBeTruthy();
  expect(view.getByText('🎨')).toBeTruthy();
  expect(view.getByText('Design')).toBeTruthy();
  expect(view.getByText('2')).toBeTruthy();
  // One workspace: no ▾.
  expect(view.queryByLabelText('workspace')).toBeNull();
  fireEvent.press(view.getByText('Engineering'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/(tabs)/(notes)/notes',
    params: { spaceId: '10' },
  });
});

it('W2: the ▾ lists your workspaces, the current one ticked, and picking one switches the page', () => {
  mockSpaces = workspaceSpaces;
  const view = render(<NotesRoot />);
  // The first workspace by name shows first.
  expect(view.getByText('ACME LEGAL')).toBeTruthy();
  expect(view.getByText('Contracts')).toBeTruthy();
  expect(view.queryByText('Design')).toBeNull();
  fireEvent.press(view.getByText('notes'));
  expect(view.getByTestId('sheet')).toBeTruthy();
  expect(view.getByText('privatePlusTeams:2')).toBeTruthy();
  fireEvent.press(view.getByText('OpenWhispr'));
  expect(view.getByText('OPENWHISPR')).toBeTruthy();
  expect(view.getByText('Design')).toBeTruthy();
  expect(view.queryByText('Contracts')).toBeNull();
  // Private stays in every workspace.
  expect(view.getByText('Meetings')).toBeTruthy();
});

it('L5/L7: an Up next card records the meeting and opens today’s other meetings', () => {
  mockUpNext = {
    next: event,
    events: [event, { ...event, id: 6, summary: 'Pricing call' }],
    now: 0,
  };
  const view = render(<NotesRoot />);
  expect(view.getByText('Weekly sync')).toBeTruthy();
  fireEvent.press(view.getByText('record'));
  expect(mockOpenMeeting).toHaveBeenCalledWith(event);
  fireEvent.press(view.getByText('moreToday:1'));
  expect(view.getByText('Pricing call')).toBeTruthy();
});

it('L8: New leads with the next meeting when one is coming up', () => {
  mockUpNext = { next: event, events: [event], now: 0 };
  const view = render(<NotesRoot />);
  fireEvent.press(view.getByLabelText('new'));
  expect(view.getByText('recordAnother')).toBeTruthy();
  fireEvent.press(view.getByText('recordEvent'));
  expect(mockOpenMeeting).toHaveBeenCalledWith(event);
});
