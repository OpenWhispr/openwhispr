import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import NoteEditorScreen from '@/screens/NoteEditorScreen';
import * as Clipboard from 'expo-clipboard';
import { exportNote } from '@/lib/noteExport';
import type {
  Action,
  ConflictedNote,
  Note,
  RemoteNote,
  Segment,
  Speaker,
  SpeakerProfile,
} from '@/data/types';
import type { Folder, Space } from '@/data';

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
  folders: [] as Folder[],
  spaceFolders: [] as Folder[],
  spaces: [] as Space[],
  folderCounts: {} as Record<number, number>,
  moveNoteToFolder: jest.fn(),
  moveNoteToSpace: jest.fn(),
  createFolder: jest.fn(),
  getSpaceFolders: jest.fn(() => [] as Folder[]),
  voiceProfiles: [] as SpeakerProfile[],
  meetingSpeakerEmbeddingsByNoteId: {} as Record<number, Record<string, number[]>>,
  claimSpeakerAsMe: jest.fn(),
  loadVoiceProfiles: jest.fn(),
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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

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

let mockOnDictationComplete: ((text: string) => void) | null = null;

jest.mock('@/hooks/useAudioRecording', () => ({
  useAudioRecording: ({ onComplete }: { onComplete: (text: string) => void }) => {
    mockOnDictationComplete = onComplete;
    return {
      isRecording: false,
      isProcessing: false,
      currentText: '',
      startRecording: jest.fn(),
      stopRecording: jest.fn(),
    };
  },
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
  NoteActionsMenu: ({
    onShare,
    onCopyGeneratedNote,
    onViewTranscript,
  }: {
    onShare: () => void;
    onCopyGeneratedNote?: () => void;
    onViewTranscript?: () => void;
  }) => {
    const { Pressable, Text, View } = require('react-native');
    return (
      <View>
        <Pressable onPress={onShare}>
          <Text>Share note</Text>
        </Pressable>
        {onCopyGeneratedNote ? (
          <Pressable onPress={onCopyGeneratedNote}>
            <Text>Copy Notes</Text>
          </Pressable>
        ) : null}
        {onViewTranscript ? (
          <Pressable onPress={onViewTranscript}>
            <Text>View Transcript</Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
}));

jest.mock('@/components/notes/TranscriptSheet', () => ({
  TranscriptSheet: ({
    visible,
    onExport,
  }: {
    visible: boolean;
    onExport: (format: 'md' | 'txt') => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    return visible ? (
      <Pressable onPress={() => onExport('txt')}>
        <Text>Export transcript</Text>
      </Pressable>
    ) : null;
  },
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

jest.mock('@/components/notes/MoveToFolderSheet', () => ({
  MoveToFolderSheet: ({ visible }: { visible: boolean }) =>
    (() => {
      const { Text: MockText } = require('react-native');
      return visible ? <MockText testID="move-sheet">move-sheet</MockText> : null;
    })(),
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

jest.mock('@/components/notes/NoteShareSheet', () => ({
  NoteShareSheet: ({
    onFlushDraft,
    onExport,
  }: {
    onFlushDraft: () => void;
    onExport: (format: 'md' | 'txt') => void;
  }) => {
    const { Pressable, Text, View } = require('react-native');
    return (
      <View>
        <Pressable onPress={onFlushDraft}>
          <Text>Create test link</Text>
        </Pressable>
        <Pressable onPress={() => onExport('md')}>
          <Text>Export Markdown</Text>
        </Pressable>
      </View>
    );
  },
}));

jest.mock('@/lib/noteExport', () => ({
  ...jest.requireActual('@/lib/noteExport'),
  exportNote: jest.fn(async () => undefined),
}));

describe('NoteEditorScreen — sharing drafts', () => {
  it('flushes title and body before publishing and does not resave on exit', () => {
    jest.useFakeTimers();
    const screen = render(<NoteEditorScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Title'), 'Latest title');
    fireEvent.changeText(screen.getByPlaceholderText('Type or dictate…'), 'Latest body');
    fireEvent.press(screen.getByText('Share note'));
    expect(mockUpdateNote).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('Create test link'));
    expect(mockUpdateNote).toHaveBeenCalledWith(7, {
      title: 'Latest title',
      content: 'Latest body',
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    screen.unmount();
    expect(mockUpdateNote).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('saves dictation that completes after the editor has closed', () => {
    jest.useFakeTimers();
    const screen = render(<NoteEditorScreen />);
    screen.unmount();
    act(() => {
      mockOnDictationComplete?.(' dictated words');
      jest.advanceTimersByTime(1000);
    });
    expect(mockUpdateNote).toHaveBeenCalledWith(7, {
      content: 'Alice owns the launch checklist. dictated words',
    });
    jest.useRealTimers();
  });

  it('exports an untitled note under the untitled label', () => {
    mockNote = note({ title: '' });
    mockNotesState.notes = [mockNote];
    const screen = render(<NoteEditorScreen />);
    fireEvent.press(screen.getByText('Share note'));
    fireEvent.press(screen.getByText('Export Markdown'));
    expect(exportNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'Untitled' }), 'md');
  });

  it('does not dirty an unchanged note when opening or publishing', () => {
    const screen = render(<NoteEditorScreen />);
    fireEvent.press(screen.getByText('Share note'));
    fireEvent.press(screen.getByText('Create test link'));
    screen.unmount();
    expect(mockUpdateNote).not.toHaveBeenCalled();
  });
});

it('flushes a meeting title without replacing its structured transcript with body text', () => {
  mockNote = note({ noteType: 'meeting', content: 'Stored body' });
  mockNotesState.notes = [mockNote];
  mockSegments = [
    {
      id: 1,
      noteId: 7,
      text: 'Spoken words',
      startMs: 0,
      endMs: 1000,
      speakerId: null,
      segmentIndex: 0,
      source: 'local',
    } as unknown as Segment,
  ];
  const screen = render(<NoteEditorScreen />);
  fireEvent.changeText(screen.getByPlaceholderText('Title'), 'Meeting title');
  fireEvent.press(screen.getByText('Share note'));
  fireEvent.press(screen.getByText('Create test link'));
  expect(mockUpdateNote).toHaveBeenCalledWith(7, { title: 'Meeting title' });
  screen.unmount();
  expect(mockUpdateNote).toHaveBeenCalledTimes(1);
});

describe('NoteEditorScreen — using the server copy mid-edit', () => {
  it('drops the unsaved edit to the generated notes and shows the server version', async () => {
    mockNote = note({ enhancedContent: '## Local notes' });
    mockNotesState.notes = [mockNote];
    mockGetConflictedNote.mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      conflictServerNote: remoteNote({ enhanced_content: '## Server notes' }),
    });
    const { getByTestId, getByText, queryByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Mine');

    // The repository now holds the server's copy.
    mockNote = note({ enhancedContent: '## Server notes' });
    mockNotesState.notes = [mockNote];
    act(() => {
      fireEvent.press(getByTestId('conflict-banner-use-server'));
    });
    // Outlast the 800 ms save debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });

    const savedEnhanced = mockUpdateNote.mock.calls.map(([, updates]) => updates.enhancedContent);
    expect(savedEnhanced).not.toContain('## Mine');
    expect(queryByTestId('enhanced-editor')).toBeNull();
    expect(getByText('## Server notes')).toBeTruthy();
  });
});

it('publishes an unfinished edit to the generated notes when sharing', () => {
  mockNote = note({ enhancedContent: '## Summary' });
  mockNotesState.notes = [mockNote];
  const screen = render(<NoteEditorScreen />);
  fireEvent.press(screen.getByTestId('enhanced-edit'));
  fireEvent.changeText(screen.getByTestId('enhanced-editor'), '## Summary\n- Shared');
  fireEvent.press(screen.getByText('Share note'));
  fireEvent.press(screen.getByText('Create test link'));
  expect(mockUpdateNote).toHaveBeenCalledWith(7, { enhancedContent: '## Summary\n- Shared' });
});

it('exports an unfinished edit to the generated notes', () => {
  mockNote = note({ enhancedContent: '## Summary' });
  mockNotesState.notes = [mockNote];
  // The store re-reads the saved note, as the repository does.
  mockUpdateNote.mockImplementationOnce((_id: number, updates: Partial<Note>) => {
    mockNote = { ...mockNote, ...updates };
  });
  const screen = render(<NoteEditorScreen />);
  fireEvent.press(screen.getByTestId('enhanced-edit'));
  fireEvent.changeText(screen.getByTestId('enhanced-editor'), '## Summary\n- Exported');
  fireEvent.press(screen.getByText('Share note'));
  fireEvent.press(screen.getByText('Export Markdown'));
  expect(exportNote).toHaveBeenCalledWith(
    expect.objectContaining({ content: '## Summary\n- Exported' }),
    'md',
  );
});

it('exports only the title from a transcript that is still being made', () => {
  mockNote = note({ noteType: 'meeting', transcriptionStatus: 'transcribing' });
  mockNotesState.notes = [mockNote];
  mockSegments = [];
  const screen = render(<NoteEditorScreen />);
  expect(screen.getByText('Transcribing audio...')).toBeTruthy();
  fireEvent.press(screen.getByText('Share note'));
  fireEvent.press(screen.getByText('Export Markdown'));
  expect(exportNote).toHaveBeenCalledWith(expect.objectContaining({ content: '' }), 'md');
});

it('copies an unfinished edit to the generated notes', () => {
  mockNote = note({ enhancedContent: '## Summary' });
  mockNotesState.notes = [mockNote];
  mockUpdateNote.mockImplementationOnce((_id: number, updates: Partial<Note>) => {
    mockNote = { ...mockNote, ...updates };
  });
  const screen = render(<NoteEditorScreen />);
  fireEvent.press(screen.getByTestId('enhanced-edit'));
  fireEvent.changeText(screen.getByTestId('enhanced-editor'), '## Summary\n- Copied');
  fireEvent.press(screen.getByText('Copy Notes'));
  expect(mockUpdateNote).toHaveBeenCalledWith(7, { enhancedContent: '## Summary\n- Copied' });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('## Summary\n- Copied');
});

it('exports the transcript as a file once notes are generated', () => {
  mockNote = note({ noteType: 'meeting', diarizationEnabled: 1, enhancedContent: '## Summary' });
  mockNotesState.notes = [mockNote];
  mockSegments = [
    {
      id: 1,
      noteId: 7,
      text: 'Spoken words',
      startMs: 0,
      endMs: 1000,
      speakerLabel: null,
      sortOrder: 0,
    } as unknown as Segment,
  ];
  const screen = render(<NoteEditorScreen />);
  fireEvent.press(screen.getByText('View Transcript'));
  fireEvent.press(screen.getByText('Export transcript'));
  expect(exportNote).toHaveBeenCalledWith(
    {
      title: 'Customer Planning Transcript',
      content: expect.stringContaining('Spoken words'),
    },
    'txt',
  );
});

describe('NoteEditorScreen — changes pulled while the note is open', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a pulled edit instead of saving the old text over it', () => {
    jest.useFakeTimers();
    const screen = render(<NoteEditorScreen />);

    mockNote = note({ title: 'Renamed on desktop', content: 'Edited on desktop.' });
    mockNotesState.notes = [mockNote];
    screen.rerender(<NoteEditorScreen />);

    const input = screen.getByPlaceholderText('Type or dictate…');
    expect(input.props.value).toBe('Edited on desktop.');
    expect(screen.getByPlaceholderText('Title').props.value).toBe('Renamed on desktop');

    fireEvent.changeText(input, 'Edited on desktop. And here.');
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(mockUpdateNote).toHaveBeenCalledTimes(1);
    expect(mockUpdateNote).toHaveBeenCalledWith(7, { content: 'Edited on desktop. And here.' });
  });

  it('keeps what you are typing when a pull lands before it saves', () => {
    jest.useFakeTimers();
    const screen = render(<NoteEditorScreen />);
    fireEvent.changeText(screen.getByPlaceholderText('Type or dictate…'), 'Typed here.');

    mockNote = note({ content: 'Edited on desktop.' });
    mockNotesState.notes = [mockNote];
    screen.rerender(<NoteEditorScreen />);

    expect(screen.getByPlaceholderText('Type or dictate…').props.value).toBe('Typed here.');
  });
});
