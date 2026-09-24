import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import NoteEditorScreen from '@/screens/NoteEditorScreen';
import type { Action, ConflictedNote, Note, RemoteNote, Segment, Speaker } from '@/data/types';

const mockUpdateNote = jest.fn();
const mockDeleteNote = jest.fn();
const mockRetryMeetingTranscription = jest.fn();
const mockRenameSpeaker = jest.fn();
const mockMergeSpeakers = jest.fn();
const mockConfirmSpeakerSuggestion = jest.fn();
const mockRejectSpeakerSuggestion = jest.fn();
const mockInitializeActions = jest.fn();
const mockAddLearnedWords = jest.fn();
const mockGetConflictedNote = jest.fn<ConflictedNote | null, [number]>(() => null);
const mockResolveConflictKeepMine = jest.fn();
const mockResolveConflictUseServer = jest.fn();

let mockNote: Note;
let mockSegments: Segment[];
let mockSpeakers: Speaker[];
let mockActions: Action[];

const mockNotesState = {
  notes: [] as Note[],
  updateNote: mockUpdateNote,
  deleteNote: mockDeleteNote,
  retryMeetingTranscription: mockRetryMeetingTranscription,
  getNoteById: jest.fn((id: number) => (mockNote?.id === id ? mockNote : null)),
  getNoteSegments: jest.fn(() => mockSegments),
  getNoteSpeakers: jest.fn(() => mockSpeakers),
  renameSpeaker: mockRenameSpeaker,
  mergeSpeakers: mockMergeSpeakers,
  confirmSpeakerSuggestion: mockConfirmSpeakerSuggestion,
  rejectSpeakerSuggestion: mockRejectSpeakerSuggestion,
  getConflictedNote: mockGetConflictedNote,
  resolveConflictKeepMine: mockResolveConflictKeepMine,
  resolveConflictUseServer: mockResolveConflictUseServer,
  transcriptRevision: 0,
};

const mockActionsState = {
  actions: [] as Action[],
  initialize: mockInitializeActions,
};

const mockAuthState = {
  user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
};

const mockProcessingModeState = {
  activeMode: 'cloud',
};

const mockConfigState = {
  config: { autoGenerateNoteTitle: false, appleLocalIntelligenceEnabled: true },
  updateConfig: jest.fn(),
};

const mockDictionaryState = {
  entries: [] as { word: string }[],
  addLearnedWords: mockAddLearnedWords,
};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '7' }),
  useRouter: () => ({
    push: jest.fn(),
    canGoBack: () => true,
    back: jest.fn(),
    replace: jest.fn(),
  }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector?: (state: typeof mockNotesState) => unknown) =>
    selector ? selector(mockNotesState) : mockNotesState,
}));

jest.mock('@/store/useActionsStore', () => ({
  useActionsStore: (selector: (state: typeof mockActionsState) => unknown) =>
    selector(mockActionsState),
}));

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
    { getState: () => mockAuthState },
  ),
}));

jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: Object.assign(
    (selector: (state: typeof mockProcessingModeState) => unknown) =>
      selector(mockProcessingModeState),
    { getState: () => mockProcessingModeState },
  ),
}));

jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: Object.assign(
    (selector?: (state: typeof mockConfigState) => unknown) =>
      selector ? selector(mockConfigState) : mockConfigState,
    { getState: () => mockConfigState },
  ),
}));

jest.mock('@/store/useDictionaryStore', () => ({
  useDictionaryStore: (selector: (state: typeof mockDictionaryState) => unknown) =>
    selector(mockDictionaryState),
}));

jest.mock('@/store/useUsageStore', () => {
  const usageState = { usage: null, load: jest.fn(async () => ({ status: 'skipped' })) };
  const useUsageStore = (selector?: (state: typeof usageState) => unknown) =>
    selector ? selector(usageState) : usageState;
  useUsageStore.getState = () => usageState;
  return { useUsageStore };
});

jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    isRecording: false,
    isProcessing: false,
    currentText: '',
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
  }),
}));

jest.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
}));

jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(),
  },
}));

jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: jest.fn(),
}));

jest.mock('@/lib/privateMode', () => ({
  promptLocalModelFallback: jest.fn(),
}));

jest.mock('@/components/ui/TabScreenHeader', () => ({
  TabScreenHeader: ({
    title,
    left,
    right,
  }: {
    title: string;
    left?: React.ReactNode;
    right?: React.ReactNode;
  }) =>
    (() => {
      const { Text: MockText, View: MockView } = require('react-native');
      return (
        <MockView>
          <MockText>{title}</MockText>
          {left}
          {right}
        </MockView>
      );
    })(),
}));

jest.mock('@/components/ui/Text', () => ({
  Text: ({ children, ...props }: { children?: React.ReactNode }) => {
    const MockReact = require('react');
    const { Text: MockText } = require('react-native');
    return MockReact.createElement(MockText, props, children);
  },
}));

jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({ children }: { children?: React.ReactNode }) =>
    (() => {
      const { View: MockView } = require('react-native');
      return <MockView>{children}</MockView>;
    })(),
  GlassCapsule: ({ children }: { children?: React.ReactNode }) =>
    (() => {
      const { View: MockView } = require('react-native');
      return <MockView>{children}</MockView>;
    })(),
}));

jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: () => null,
}));

jest.mock('@/components/notes/NoteActionsMenu', () => ({
  NoteActionsMenu: () => null,
}));

jest.mock('@/components/notes/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    (() => {
      const { Text: MockText } = require('react-native');
      return <MockText>{content}</MockText>;
    })(),
}));

jest.mock('@/components/notes/SpeakerTranscript', () => ({
  SpeakerTranscript: () => null,
}));

jest.mock('@/components/notes/SpeakerRenameSheet', () => ({
  SpeakerRenameSheet: () => null,
}));

jest.mock('@/components/notes/SpeakerMergeSheet', () => ({
  SpeakerMergeSheet: () => null,
}));

jest.mock('@/components/notes/VoiceprintSuggestionSheet', () => ({
  VoiceprintSuggestionSheet: () => null,
}));

jest.mock('@/components/notes/NoteChatSheet', () => ({
  NoteChatSheet: () => null,
}));

/*
 * Keep the mocks above self-contained because Jest hoists mock factories before
 * imports are initialized.
 */

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 7,
    title: 'Customer Planning',
    content: 'Alice owns the launch checklist.',
    folderId: 1,
    noteType: 'personal',
    sourceFile: null,
    audioDurationSeconds: null,
    enhancedContent: null,
    enhancementPrompt: null,
    enhancedAtContentHash: null,
    diarizationEnabled: 0,
    expectedSpeakerCount: null,
    transcriptionStatus: 'idle',
    calendarEventId: null,
    participants: null,
    conflictServerNote: null,
    clientNoteId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    isPrivate: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Note;

const remoteNote = (overrides: Partial<RemoteNote> = {}): RemoteNote => ({
  id: 'srv-7',
  client_note_id: 'client-7',
  title: 'Server title',
  content: 'Server content',
  enhanced_content: null,
  enhancement_prompt: null,
  note_type: 'personal',
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  participants: null,
  calendar_event_id: null,
  transcript: null,
  deleted_at: null,
  updated_at: '2026-08-24T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockActions = [];
  mockActionsState.actions = mockActions;
  mockNote = note();
  mockNotesState.notes = [mockNote];
  mockSegments = [];
  mockSpeakers = [];
  mockGetConflictedNote.mockReturnValue(null);
});

describe('NoteEditorScreen — conflict banner', () => {
  it('renders no banner when the note has no parked conflict', () => {
    const { queryByTestId } = render(<NoteEditorScreen />);

    expect(queryByTestId('conflict-banner')).toBeNull();
  });

  it('renders the banner with both actions when the note is conflicted with a parseable server copy', () => {
    mockGetConflictedNote.mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      conflictServerNote: remoteNote(),
    });

    const { getByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('conflict-banner')).toBeTruthy();
    expect(getByTestId('conflict-banner-keep-mine')).toBeTruthy();
    expect(getByTestId('conflict-banner-use-server')).toBeTruthy();
  });

  it('hides Use server copy when the parked payload is null (unparseable)', () => {
    mockGetConflictedNote.mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      conflictServerNote: null,
    });

    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);

    expect(getByTestId('conflict-banner-keep-mine')).toBeTruthy();
    expect(queryByTestId('conflict-banner-use-server')).toBeNull();
  });

  it('Keep mine calls resolveConflictKeepMine with the note id', () => {
    mockGetConflictedNote.mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      conflictServerNote: remoteNote(),
    });

    const { getByTestId } = render(<NoteEditorScreen />);
    act(() => {
      fireEvent.press(getByTestId('conflict-banner-keep-mine'));
    });

    expect(mockResolveConflictKeepMine).toHaveBeenCalledWith(7);
  });

  it('Use server copy calls resolveConflictUseServer and re-reads the note from the repository', () => {
    mockGetConflictedNote.mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      conflictServerNote: remoteNote(),
    });

    const { getByTestId } = render(<NoteEditorScreen />);
    act(() => {
      fireEvent.press(getByTestId('conflict-banner-use-server'));
    });

    expect(mockResolveConflictUseServer).toHaveBeenCalledWith(7);
    // Called once on initial mount (to derive `note`) and again to refresh the local draft
    // after the resolve.
    expect(mockNotesState.getNoteById).toHaveBeenCalledWith(7);
  });
});
