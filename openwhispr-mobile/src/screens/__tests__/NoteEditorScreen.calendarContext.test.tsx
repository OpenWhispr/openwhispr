import React from 'react';
import { Alert, Modal, Platform } from 'react-native';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import NoteEditorScreen from '@/screens/NoteEditorScreen';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { generateNoteTitle } from '@/utils/generateTitle';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { makeContentHash } from '@/lib/utils';
import { clearLocalReasoningReadinessCache, LocalReasoningError } from '@/lib/localReasoning';
import { extractCorrections } from '@/lib/correctionLearner';
import type { Action, Note, Segment, Speaker, SpeakerProfile } from '@/data/types';
import type { Folder, Space } from '@/data';
import type { UserConfig } from '@/types';

const mockUpdateNote = jest.fn();
const mockDeleteNote = jest.fn();
const mockRetryMeetingTranscription = jest.fn();
const mockRenameSpeaker = jest.fn();
const mockMergeSpeakers = jest.fn();
const mockConfirmSpeakerSuggestion = jest.fn();
const mockRejectSpeakerSuggestion = jest.fn();
const mockInitializeActions = jest.fn();
const mockAddLearnedWords = jest.fn();
const mockUpdateConfig = jest.fn(async (updates: Record<string, unknown>) => {
  mockConfigState.config = { ...mockConfigState.config, ...updates };
});
const mockClaimSpeakerAsMe = jest.fn();
const mockLoadVoiceProfiles = jest.fn();

let mockNote: Note;
let mockRouteNoteId = '7';
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
  getConflictedNote: jest.fn(() => null),
  resolveConflictKeepMine: jest.fn(),
  resolveConflictUseServer: jest.fn(),
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
  claimSpeakerAsMe: mockClaimSpeakerAsMe,
  loadVoiceProfiles: mockLoadVoiceProfiles,
};

const mockActionsState = {
  actions: [] as Action[],
  initialize: mockInitializeActions,
};

const mockAuthState: { user: { id: string; email: string; emailVerified: boolean } | null } = {
  user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
};

const mockProcessingModeState = {
  activeMode: 'cloud',
};

const mockConfigState: { config: Partial<UserConfig>; updateConfig: typeof mockUpdateConfig } = {
  config: { autoGenerateNoteTitle: false, appleLocalIntelligenceEnabled: true },
  updateConfig: mockUpdateConfig,
};

const mockDictionaryState = {
  entries: [] as { word: string }[],
  addLearnedWords: mockAddLearnedWords,
};

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockRouteNoteId }),
  useRouter: () => ({
    push: mockPush,
    canGoBack: () => true,
    back: jest.fn(),
    replace: jest.fn(),
  }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => undefined),
}));

jest.mock('@/lib/transcriptAudio', () => ({
  ...jest.requireActual('@/lib/transcriptAudio'),
  isManagedMeetingAudioUri: (noteId: number, uri?: string | null) =>
    uri === `managed://meeting-${noteId}.wav`,
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
    chatOverNote: jest.fn(),
  },
}));

let mockAppleAvailability = 'available';
jest.mock('@/lib/appleLLM', () => ({
  AppleLLM: { getAvailability: jest.fn(async () => ({ status: mockAppleAvailability })) },
}));

const mockRegisterSuperwallGate = jest.fn(async ({ feature }: { feature?: () => void }) => {
  feature?.();
  return true;
});
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegisterSuperwallGate }),
}));

jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: jest.fn(),
}));

jest.mock('@/lib/privateMode', () => ({
  promptLocalModelFallback: jest.fn(),
}));

jest.mock('@/lib/correctionLearner', () => ({
  extractCorrections: jest.fn(() => []),
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
    actions,
    onRunAction,
    onAskNote,
    askNoteDisabled,
    onViewTranscript,
  }: {
    actions: Action[];
    onRunAction: (action: Action) => void;
    onAskNote?: () => void;
    askNoteDisabled?: boolean;
    onViewTranscript?: () => void;
  }) =>
    (() => {
      const { Pressable: MockPressable, Text: MockText, View: MockView } = require('react-native');
      return (
        <MockView>
          {actions.map((action) => (
            <MockPressable
              key={action.id}
              testID={`run-action-${action.id}`}
              onPress={() => onRunAction(action)}
            >
              <MockText>{action.name}</MockText>
            </MockPressable>
          ))}
          {onAskNote ? (
            <MockText testID="menu-ask-note" accessibilityState={{ disabled: !!askNoteDisabled }}>
              Ask about this note
            </MockText>
          ) : null}
          {onViewTranscript ? (
            <MockPressable testID="menu-view-transcript" onPress={onViewTranscript}>
              <MockText>View Transcript</MockText>
            </MockPressable>
          ) : null}
        </MockView>
      );
    })(),
}));

jest.mock('@/components/notes/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    (() => {
      const { Text: MockText } = require('react-native');
      return <MockText>{content}</MockText>;
    })(),
}));

jest.mock('@/components/notes/SpeakerTranscript', () => ({
  SpeakerTranscript: ({
    blocks,
    onSpeakerPress,
  }: {
    blocks: { text: string }[];
    onSpeakerPress?: (block: { text: string }) => void;
  }) =>
    (() => {
      const { Text: MockText, View: MockView } = require('react-native');
      return (
        <MockView>
          {blocks.map((block, index) => (
            <MockText key={index} onPress={() => onSpeakerPress?.(block)}>
              {block.text}
            </MockText>
          ))}
        </MockView>
      );
    })(),
}));

jest.mock('@/components/notes/SpeakerRenameSheet', () => ({
  SpeakerRenameSheet: ({ visible }: { visible: boolean }) =>
    (() => {
      const { View: MockView } = require('react-native');
      return visible ? <MockView testID="speaker-rename-sheet" /> : null;
    })(),
}));

jest.mock('@/components/notes/SpeakerMergeSheet', () => ({
  SpeakerMergeSheet: () => null,
}));

jest.mock('@/components/notes/VoiceprintSuggestionSheet', () => ({
  VoiceprintSuggestionSheet: () => null,
}));

jest.mock('@/components/notes/TranscriptSheet', () => ({
  TranscriptSheet: ({
    visible,
    shareText,
    children,
  }: {
    visible: boolean;
    shareText: string;
    children?: React.ReactNode;
  }) =>
    (() => {
      const { Text: MockText, View: MockView } = require('react-native');
      return visible ? (
        <MockView>
          <MockText testID="transcript-sheet">{shareText}</MockText>
          {children}
        </MockView>
      ) : null;
    })(),
}));

jest.mock('@/components/notes/MoveToFolderSheet', () => ({
  MoveToFolderSheet: ({ visible }: { visible: boolean }) =>
    (() => {
      const { Text: MockText } = require('react-native');
      return visible ? <MockText testID="move-sheet">move-sheet</MockText> : null;
    })(),
}));

jest.mock('@/components/notes/NoteChatSheet', () => ({
  NoteChatSheet: ({
    draft,
    canSend,
    suggestions,
    onDraftChange,
    onSend,
    onSuggestion,
    onClose,
  }: {
    draft: string;
    canSend: boolean;
    suggestions: readonly { label: string; prompt: string }[];
    onDraftChange: (text: string) => void;
    onSend: () => void;
    onSuggestion: (prompt: string) => void;
    onClose: () => void;
  }) =>
    (() => {
      const {
        Pressable: MockPressable,
        TextInput: MockTextInput,
        View: MockView,
      } = require('react-native');
      return (
        <MockView>
          <MockTextInput testID="chat-draft" value={draft} onChangeText={onDraftChange} />
          <MockPressable
            testID="chat-send"
            accessibilityState={{ disabled: !canSend }}
            onPress={onSend}
          />
          <MockPressable testID="chat-close" onPress={onClose} />
          {suggestions.map((suggestion) => (
            <MockPressable
              key={suggestion.label}
              testID={`chat-suggestion-${suggestion.label}`}
              onPress={() => onSuggestion(suggestion.prompt)}
            />
          ))}
        </MockView>
      );
    })(),
}));

/*
 * Keep the mocks above self-contained because Jest hoists mock factories before
 * imports are initialized.
 */

const defaultAction = (overrides: Partial<Action> = {}): Action =>
  ({
    id: 1,
    name: 'Generate Notes',
    description: 'Turn rough dictation into notes',
    prompt: 'Transform this meeting into notes.',
    isDefault: 1,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Action;

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 7,
    title: 'Customer Planning',
    content: 'Alice owns the launch checklist.',
    folderId: 1,
    noteType: 'meeting',
    sourceFile: null,
    audioDurationSeconds: null,
    enhancedContent: null,
    enhancementPrompt: null,
    enhancedAtContentHash: null,
    diarizationEnabled: 1,
    expectedSpeakerCount: 2,
    transcriptionStatus: 'done',
    calendarEventId: 'calendar-event-context',
    participants: JSON.stringify([
      {
        email: 'alice@example.com',
        displayName: 'Alice Adams',
        responseStatus: 'accepted',
        optional: false,
        organizer: false,
        resource: false,
        self: false,
      },
    ]),
    clientNoteId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    isPrivate: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Note;

const segment = (overrides: Partial<Segment> = {}): Segment =>
  ({
    id: 20,
    noteId: 7,
    startMs: 0,
    endMs: 2000,
    text: 'Alice can take the first pass.',
    speakerLabel: 'speaker_0',
    sortOrder: 0,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Segment;

const speaker = (overrides: Partial<Speaker> = {}): Speaker =>
  ({
    id: 10,
    noteId: 7,
    speakerLabel: 'speaker_0',
    displayName: null,
    profileId: null,
    color: null,
    sortOrder: 0,
    speakerStatus: 'provisional',
    speakerLocked: 0,
    speakerLockSource: null,
    clientId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Speaker;

const calendarContextInputForCurrentNote = (): string =>
  buildMeetingNotesInput({
    rawNotes: mockNote.content,
    transcript: formatTranscriptForExport({
      segments: mockSegments,
      speakers: mockSpeakers,
    }),
    meetingContext: {
      eventTitle: mockNote.title,
      participants: JSON.parse(mockNote.participants ?? '[]'),
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  clearLocalReasoningReadinessCache();
  mockRouteNoteId = '7';
  mockAppleAvailability = 'available';
  mockAuthState.user = { id: 'user-1', email: 'user@example.com', emailVerified: true };
  mockConfigState.config.inference = undefined;
  mockConfigState.config.dictationAgentEnabled = undefined;
  mockConfigState.config.noteChatEnabled = undefined;
  mockProcessingModeState.activeMode = 'cloud';
  mockActions = [defaultAction()];
  mockActionsState.actions = mockActions;
  mockNote = note();
  mockNotesState.notes = [mockNote];
  mockSegments = [segment()];
  mockSpeakers = [speaker()];
  mockConfigState.config.autoGenerateNoteTitle = false;
  mockConfigState.config.appleLocalIntelligenceEnabled = true;
  mockConfigState.config.voiceSetupBannerDismissedAt = undefined;
  mockNotesState.voiceProfiles = [];
  mockNotesState.meetingSpeakerEmbeddingsByNoteId = {};
  mockUpdateConfig.mockClear();
  (ReasoningService.processText as jest.Mock).mockResolvedValue({
    text: 'Generated calendar-aware notes',
    model: 'test',
  });
});

describe('NoteEditorScreen generated meeting context', () => {
  it('sends calendar context for the default Generate Notes action and stores that input hash', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.text).toContain(
      'Calendar context (for interpretation only; do not list this context automatically):',
    );
    expect(request.text).toContain('Event title: Customer Planning');
    expect(request.text).toContain('Possible participant hints: Alice Adams <alice@example.com>');
    expect(request.text).not.toContain('Meeting transcript:\nCustomer Planning');

    await waitFor(() =>
      expect(mockUpdateNote).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          enhancedContent: 'Generated calendar-aware notes',
          enhancementPrompt: 'Transform this meeting into notes.',
          enhancedAtContentHash: makeContentHash(request.text),
        }),
      ),
    );
  });

  it('omits unknown speaker labels when manually regenerating cloud meeting notes', async () => {
    mockNote = note({
      title: 'Cloud Planning',
      content: '',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [segment({ text: 'Ship the onboarding fix.', speakerLabel: null })];
    mockSpeakers = [];

    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.text).toContain(
      'Meeting transcript:\nCloud Planning\n\n[0:00] Ship the onboarding fix.',
    );
    expect(request.text).not.toContain('Unknown speaker');
  });

  it('offers enable local AI alongside cloud once when local intelligence is disabled', async () => {
    mockProcessingModeState.activeMode = 'private';
    mockConfigState.config.appleLocalIntelligenceEnabled = false;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    const { getByTestId } = render(<NoteEditorScreen />);

    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const buttons = alertSpy.mock.calls[0][2] ?? [];
    expect(buttons.map((button) => button.text)).toEqual([
      'Cancel',
      'Enable Local AI',
      'Use Cloud Once',
    ]);

    await act(async () => {
      buttons[1]?.onPress?.();
    });

    await waitFor(() =>
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        appleLocalIntelligenceEnabled: true,
      }),
    );
    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));

    alertSpy.mockRestore();
    mockProcessingModeState.activeMode = 'cloud';
  });

  it('does not mark a freshly generated calendar-context note stale before actions load', () => {
    mockActions = [];
    mockActionsState.actions = mockActions;
    const currentInput = calendarContextInputForCurrentNote();
    mockNote = note({
      enhancedContent: 'Generated calendar-aware notes',
      enhancementPrompt: 'Transform this meeting into notes.',
      enhancedAtContentHash: makeContentHash(currentInput),
    });
    mockNotesState.notes = [mockNote];

    const { queryByTestId } = render(<NoteEditorScreen />);

    expect(queryByTestId('enhanced-stale-indicator')).toBeNull();
  });
});

describe('NoteEditorScreen note chat', () => {
  const PILL = 'note-ask-pill';

  it('shows the Ask pill instead of the menu entry once a meeting has finished', () => {
    const { getByTestId, queryByText } = render(<NoteEditorScreen />);
    expect(getByTestId(PILL)).toBeTruthy();
    expect(queryByText('Ask about this note')).toBeNull();
  });

  it('shows the Ask pill for a synced meeting that kept the local idle status', () => {
    mockNote = note({ transcriptionStatus: 'idle' });
    mockNotesState.notes = [mockNote];
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId(PILL)).toBeTruthy();
  });

  it('keeps the Ask pill once notes have been generated', () => {
    mockNote = note({
      enhancedContent: 'Generated calendar-aware notes',
      enhancementPrompt: 'Transform this meeting into notes.',
    });
    mockNotesState.notes = [mockNote];
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId(PILL)).toBeTruthy();
  });

  it.each(['recording', 'transcribing', 'diarizing'] as const)(
    'hides the Ask pill while the meeting is %s',
    (transcriptionStatus) => {
      mockNote = note({ transcriptionStatus });
      mockNotesState.notes = [mockNote];
      const { queryByTestId } = render(<NoteEditorScreen />);
      expect(queryByTestId(PILL)).toBeNull();
    },
  );

  it('keeps Ask about this note in the menu and note-worded shortcuts for a plain note', () => {
    mockNote = note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByText, getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    expect(getByText('Ask about this note')).toBeTruthy();
    expect(queryByTestId(PILL)).toBeNull();
    expect(getByTestId('chat-suggestion-Summarize')).toBeTruthy();
    expect(queryByTestId('chat-suggestion-Key decisions')).toBeNull();
  });

  it('lets you ask about a plain note that only has generated notes', () => {
    mockNote = note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
      content: '',
      enhancedContent: '## Summary',
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('menu-ask-note').props.accessibilityState.disabled).toBe(false);
  });

  it('disables Ask on an empty plain note', () => {
    mockNote = note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
      content: '',
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('menu-ask-note').props.accessibilityState.disabled).toBe(true);
  });

  it('offers note-worded shortcuts for an uploaded recording', () => {
    mockNote = note({ noteType: 'upload', diarizationEnabled: 0, calendarEventId: null });
    mockNotesState.notes = [mockNote];
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId(PILL)).toBeTruthy();
    expect(getByTestId('chat-suggestion-Summarize')).toBeTruthy();
    expect(queryByTestId('chat-suggestion-Key decisions')).toBeNull();
  });

  it.each([
    ['note chat is off', { noteChatEnabled: false }],
    ['the old shared switch was turned off', { dictationAgentEnabled: false }],
  ])('hides every Ask entry point when %s', (_label, settings) => {
    Object.assign(mockConfigState.config, settings);
    const { queryByText, queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByText('Ask about this note')).toBeNull();
    expect(queryByTestId(PILL)).toBeNull();
  });

  it('keeps note chat when only the voice assistant is off', () => {
    Object.assign(mockConfigState.config, { dictationAgentEnabled: false, noteChatEnabled: true });
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId(PILL)).toBeTruthy();
  });

  it('sends a meeting shortcut prompt immediately when its chip is tapped', async () => {
    (ReasoningService.chatOverNote as jest.Mock).mockResolvedValue({ text: 'Answer', model: 'x' });
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('chat-suggestion-List action items'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1));
    expect((ReasoningService.chatOverNote as jest.Mock).mock.calls[0][0].question).toBe(
      'What are the next steps from the meeting above that I need to do?',
    );
  });

  it('asks about the note and its generated notes', async () => {
    mockNote = note({ enhancedContent: '## Summary\n- Launch Friday' });
    mockNotesState.notes = [mockNote];
    (ReasoningService.chatOverNote as jest.Mock).mockResolvedValue({ text: 'Answer', model: 'x' });
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('chat-suggestion-List action items'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1));
    const { context } = (ReasoningService.chatOverNote as jest.Mock).mock.calls[0][0];
    expect(context).toContain('Alice owns the launch checklist.');
    expect(context).toContain('Generated notes:\n## Summary\n- Launch Friday');
  });

  it('asks about the note alone when the generated notes push it past the on-device limit', async () => {
    mockNote = note({ enhancedContent: '## Summary\n- Launch Friday' });
    mockNotesState.notes = [mockNote];
    (ReasoningService.chatOverNote as jest.Mock)
      .mockRejectedValueOnce(new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too large'))
      .mockResolvedValueOnce({ text: 'Answer', model: 'x' });
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('chat-suggestion-List action items'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(2));
    const retry = (ReasoningService.chatOverNote as jest.Mock).mock.calls[1][0];
    expect(retry.context).toContain('Alice owns the launch checklist.');
    expect(retry.context).not.toContain('Launch Friday');
  });

  it('does not ask again once the chat is closed', async () => {
    mockNote = note({ enhancedContent: '## Summary\n- Launch Friday' });
    mockNotesState.notes = [mockNote];
    let failFirstAsk: (error: Error) => void = () => undefined;
    (ReasoningService.chatOverNote as jest.Mock).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failFirstAsk = reject;
      }),
    );
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('chat-suggestion-List action items'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1));

    fireEvent.press(getByTestId('chat-close'));
    await act(async () => {
      failFirstAsk(new LocalReasoningError('LOCAL_CONTEXT_LIMIT', 'Too large'));
    });

    expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1);
  });

  it('lets you send a question about a note that only has generated notes', () => {
    mockNote = note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
      content: '',
      enhancedContent: '## Summary',
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('chat-send').props.accessibilityState.disabled).toBe(false);
  });

  it('asks only once when chat fails for another reason', async () => {
    mockNote = note({ enhancedContent: '## Summary\n- Launch Friday' });
    mockNotesState.notes = [mockNote];
    (ReasoningService.chatOverNote as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('chat-suggestion-List action items'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1);
  });
});

describe('NoteEditorScreen generated titles', () => {
  const personalNote = (title: string): Note =>
    note({
      title,
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
    });

  beforeEach(() => {
    mockConfigState.config.autoGenerateNoteTitle = true;
    mockSegments = [];
    mockSpeakers = [];
    (generateNoteTitle as jest.Mock).mockResolvedValue('Launch checklist');
  });

  it('applies the generated title to a note still carrying the default title', async () => {
    mockNote = personalNote('Untitled');
    mockNotesState.notes = [mockNote];

    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    await waitFor(() =>
      expect(mockUpdateNote).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ title: 'Launch checklist' }),
      ),
    );
  });

  it('keeps a title the user typed', async () => {
    mockNote = personalNote('Customer Planning');
    mockNotesState.notes = [mockNote];

    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    await waitFor(() => expect(mockUpdateNote).toHaveBeenCalledTimes(1));
    expect(mockUpdateNote.mock.calls[0][1]).not.toHaveProperty('title');
  });
});

jest.mock('@/components/notes/NoteShareSheet', () => ({ NoteShareSheet: () => null }));

it('runs signed-out note formatting through Providers without requiring a Cloud account', async () => {
  mockAuthState.user = null;
  mockConfigState.config.inference = {
    notes: {
      mode: 'providers',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      credentialRef: 'provider.openai',
    },
  };
  const { getByTestId } = render(<NoteEditorScreen />);
  await act(async () => {
    fireEvent.press(getByTestId('run-action-1'));
  });
  await waitFor(() =>
    expect(ReasoningService.processText).toHaveBeenCalledWith(
      expect.objectContaining({ inferenceScope: 'notes' }),
    ),
  );
});

describe('NoteEditorScreen On-Device and provider routes', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => alertSpy.mockRestore());

  it('explains instead of offering Cloud when Note Formatting is On-Device', async () => {
    mockProcessingModeState.activeMode = 'private';
    mockAppleAvailability = 'deviceNotEligible';
    mockConfigState.config.inference = { notes: { mode: 'local' } };
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const [, message, buttons] = alertSpy.mock.calls[0];
    expect(message).toContain('Note Formatting is set to On-Device');
    expect((buttons ?? []).map((button: { text: string }) => button.text)).not.toContain(
      'Use Cloud Once',
    );
    expect(ReasoningService.processText).not.toHaveBeenCalled();
  });

  it('runs an On-Device action on a public note without the Cloud sign-in or paywall', async () => {
    // An anonymous session is exactly what the Cloud account check and paywall would stop.
    mockAuthState.user = { ...mockAuthState.user!, isAnonymous: true } as typeof mockAuthState.user;
    mockConfigState.config.inference = { notes: { mode: 'local' } };
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });
    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));
    expect(mockRegisterSuperwallGate).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('names the provider when it offers to send a private note there once', async () => {
    mockProcessingModeState.activeMode = 'private';
    mockAppleAvailability = 'deviceNotEligible';
    mockConfigState.config.inference = {
      notes: {
        mode: 'providers',
        providerId: 'groq',
        modelId: 'llama',
        credentialRef: 'provider.groq',
      },
    };
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const [, message, buttons] = alertSpy.mock.calls[0];
    expect(message).toContain('Groq');
    expect(message).not.toMatch(/cloud AI/);
    const labels = (buttons ?? []).map((button: { text: string }) => button.text);
    expect(labels).toContain('Use Groq Once');
    expect(labels).not.toContain('Use Cloud Once');
  });

  it('still offers to enable local AI when the fallback is a provider', async () => {
    mockProcessingModeState.activeMode = 'private';
    mockConfigState.config.appleLocalIntelligenceEnabled = false;
    mockConfigState.config.inference = {
      notes: {
        mode: 'providers',
        providerId: 'groq',
        modelId: 'llama',
        credentialRef: 'provider.groq',
      },
    };
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const labels = (alertSpy.mock.calls[0][2] ?? []).map((button: { text: string }) => button.text);
    expect(labels).toEqual(['Cancel', 'Enable Local AI', 'Use Groq Once']);
  });

  it('lets a signed-out user chat with a note when chat is On-Device', async () => {
    mockAuthState.user = null;
    mockConfigState.config.inference = { agent: { mode: 'local' } };
    (ReasoningService.chatOverNote as jest.Mock).mockResolvedValue({ text: 'Answer', model: 'x' });
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('chat-draft'), 'Who owns the launch?');
    await act(async () => {
      fireEvent.press(getByTestId('chat-send'));
    });
    await waitFor(() => expect(ReasoningService.chatOverNote).toHaveBeenCalledTimes(1));
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockRegisterSuperwallGate).not.toHaveBeenCalled();
  });
});

describe('NoteEditorScreen body tabs', () => {
  const plainNote = (overrides: Partial<Note> = {}): Note =>
    note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
      ...overrides,
    });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows Transcript and My notes on a meeting before notes are generated', () => {
    const { getByTestId, queryByTestId, getByText } = render(<NoteEditorScreen />);
    expect(getByTestId('note-tab-transcript')).toBeTruthy();
    expect(getByTestId('note-tab-notes')).toBeTruthy();
    expect(queryByTestId('note-tab-enhanced')).toBeNull();
    expect(getByText('Alice can take the first pass.')).toBeTruthy();
  });

  it('shows Enhanced and My notes once notes are generated', () => {
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    const { getByTestId, queryByTestId, getByText } = render(<NoteEditorScreen />);
    expect(getByTestId('note-tab-enhanced')).toBeTruthy();
    expect(getByTestId('note-tab-notes')).toBeTruthy();
    expect(queryByTestId('note-tab-transcript')).toBeNull();
    expect(getByText('## Summary')).toBeTruthy();
  });

  it('shows no tabs on a plain note without generated notes', () => {
    mockNote = plainNote();
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { queryByTestId, getByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('note-tab-notes')).toBeNull();
    expect(getByTestId('note-content-input')).toBeTruthy();
  });

  it('shows the processing status on the Transcript tab and keeps My notes reachable', () => {
    mockNote = note({ transcriptionStatus: 'transcribing' });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByText, getByTestId, queryByTestId, queryByText } = render(<NoteEditorScreen />);
    expect(getByText('Transcribing audio...')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();

    fireEvent.press(getByTestId('note-tab-notes'));

    expect(getByTestId('note-content-input').props.value).toBe('Alice owns the launch checklist.');
    expect(queryByText('Transcribing audio...')).toBeNull();
  });

  it('keeps a failed transcript on its own tab beside the generated notes and My notes', () => {
    mockNote = note({ transcriptionStatus: 'failed', enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByText, getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('note-tab-enhanced')).toBeTruthy();
    expect(getByTestId('note-tab-notes')).toBeTruthy();

    fireEvent.press(getByTestId('note-tab-transcript'));

    expect(getByText('Transcript failed')).toBeTruthy();
  });

  it('never shows an uploaded file’s body, the flat copy of its transcript, as My notes', () => {
    mockNote = note({
      noteType: 'upload',
      calendarEventId: null,
      participants: null,
      content: 'Alice can take the first pass.',
    });
    mockNotesState.notes = [mockNote];
    const { getByText, queryByTestId } = render(<NoteEditorScreen />);
    expect(getByText('Alice can take the first pass.')).toBeTruthy();
    expect(queryByTestId('note-tab-notes')).toBeNull();
    expect(queryByTestId('note-content-input')).toBeNull();
  });

  it('keeps an uploaded file’s transcript as a tab once notes are generated', () => {
    mockNote = note({
      noteType: 'upload',
      calendarEventId: null,
      participants: null,
      enhancedContent: '## Summary',
    });
    mockNotesState.notes = [mockNote];
    const { getByText, getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('note-tab-enhanced')).toBeTruthy();
    expect(queryByTestId('note-tab-notes')).toBeNull();

    fireEvent.press(getByTestId('note-tab-transcript'));

    expect(getByText('Alice can take the first pass.')).toBeTruthy();
    expect(queryByTestId('note-content-input')).toBeNull();
  });

  it('shows an uploaded file without segments as its editable transcript text', () => {
    mockNote = note({
      noteType: 'upload',
      calendarEventId: null,
      participants: null,
      diarizationEnabled: 0,
      content: 'Alice can take the first pass.',
      enhancedContent: '## Summary',
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    const bodyTab = getByTestId('note-tab-notes');
    expect(within(bodyTab).getByText('Transcript')).toBeTruthy();

    fireEvent.press(bodyTab);

    expect(getByTestId('note-content-input').props.value).toBe('Alice can take the first pass.');
  });

  it('saves edits to the typed meeting notes without learning dictionary corrections', () => {
    jest.useFakeTimers();
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-tab-notes'));
    const input = getByTestId('note-content-input');
    expect(input.props.value).toBe('Alice owns the launch checklist.');

    fireEvent.changeText(input, 'Alice owns the launch checklist and the demo.');
    act(() => {
      jest.advanceTimersByTime(800);
    });

    // Only changed fields are saved.
    expect(mockUpdateNote).toHaveBeenCalledWith(7, {
      content: 'Alice owns the launch checklist and the demo.',
    });
    expect(extractCorrections).not.toHaveBeenCalled();
  });

  it('still learns dictionary corrections from plain note edits', () => {
    jest.useFakeTimers();
    mockNote = plainNote();
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Alice owns the launch checklists.');
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(extractCorrections).toHaveBeenCalled();
  });

  it('still learns dictionary corrections from a meeting without a transcript, which can be dictated into', () => {
    jest.useFakeTimers();
    mockNote = note({ transcriptionStatus: 'done' });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.changeText(getByTestId('note-content-input'), 'Alice owns the launch checklists.');
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(extractCorrections).toHaveBeenCalled();
  });

  it('keeps My notes read-only while the meeting is still recording them', () => {
    mockNote = note({ transcriptionStatus: 'recording' });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { getByTestId, getByText } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-tab-notes'));
    expect(getByTestId('note-content-input').props.editable).toBe(false);
    expect(getByText('You can edit these notes once the recording stops.')).toBeTruthy();
  });

  it('switches from Transcript to Enhanced when generated notes arrive', () => {
    const { rerender, getByText, queryByText } = render(<NoteEditorScreen />);
    expect(getByText('Alice can take the first pass.')).toBeTruthy();

    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    expect(getByText('## Summary')).toBeTruthy();
    expect(queryByText('Alice can take the first pass.')).toBeNull();
  });

  it('stays on My notes when generated notes arrive', () => {
    const { rerender, getByTestId } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-tab-notes'));

    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    expect(getByTestId('note-content-input')).toBeTruthy();
  });

  it('saves edits to the generated notes when Done is pressed', () => {
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    const { getByTestId } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Summary\n- Launch Friday');
    fireEvent.press(getByTestId('enhanced-done'));

    expect(mockUpdateNote).toHaveBeenCalledWith(7, {
      enhancedContent: '## Summary\n- Launch Friday',
    });
  });

  it('saves an unfinished edit to the generated notes when the screen closes', () => {
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    const { getByTestId, unmount } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '## Summary\n- Draft');
    unmount();

    expect(mockUpdateNote).toHaveBeenCalledWith(7, { enhancedContent: '## Summary\n- Draft' });
  });
});

describe('NoteEditorScreen replacing generated notes', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
  });
  afterEach(() => alertSpy.mockRestore());

  const pressReplace = async (): Promise<void> => {
    const buttons = (alertSpy.mock.calls[0][2] ?? []) as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find((button) => button.text === 'Replace')?.onPress?.();
    });
  };

  it('asks before an action replaces the generated notes', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Replace enhanced notes?',
      'Running this action replaces the current enhanced notes, including any edits.',
      expect.any(Array),
    );
    expect(ReasoningService.processText).not.toHaveBeenCalled();

    await pressReplace();
    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));
  });

  it('leaves the notes alone when the replacement is cancelled', async () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });
    const buttons = (alertSpy.mock.calls[0][2] ?? []) as { text: string; style?: string }[];
    expect(buttons.map((button) => button.text)).toEqual(['Cancel', 'Replace']);
    expect(buttons[0].style).toBe('cancel');
    expect(ReasoningService.processText).not.toHaveBeenCalled();
  });

  const runActionOverEdit = async (): Promise<ReturnType<typeof render>> => {
    const screen = render(<NoteEditorScreen />);
    fireEvent.press(screen.getByTestId('enhanced-edit'));
    fireEvent.changeText(screen.getByTestId('enhanced-editor'), '## Edited');
    await act(async () => {
      fireEvent.press(screen.getByTestId('run-action-1'));
    });
    await pressReplace();
    await waitFor(() => expect(ReasoningService.processText).toHaveBeenCalledTimes(1));
    // Outlast the 800 ms save debounce.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    return screen;
  };
  const savedEnhanced = (): unknown[] =>
    mockUpdateNote.mock.calls
      .map(([, updates]) => updates.enhancedContent)
      .filter((value) => value !== undefined);

  it('saves an unsaved edit before the action, so it cannot overwrite the new notes', async () => {
    await runActionOverEdit();

    const saved = savedEnhanced();
    expect(saved[0]).toBe('## Edited');
    expect(saved.filter((value) => value === '## Edited')).toHaveLength(1);
  });

  it('asks before replacing notes typed since they were last cleared', async () => {
    mockUpdateNote.mockImplementation((id: number, updates: Partial<Note>) => {
      mockNote = { ...mockNote!, ...updates };
      mockNotesState.notes = [mockNote];
    });
    const { getByTestId, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '');
    // Outlast the 800 ms save debounce, so the cleared notes are what is saved.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    rerender(<NoteEditorScreen />);
    expect(mockNote?.enhancedContent).toBe('');

    fireEvent.changeText(getByTestId('enhanced-editor'), '## Rewritten');
    await act(async () => {
      fireEvent.press(getByTestId('run-action-1'));
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Replace enhanced notes?',
      expect.any(String),
      expect.any(Array),
    );
    expect(ReasoningService.processText).not.toHaveBeenCalled();
  });

  it('keeps an unsaved edit when the action fails', async () => {
    (ReasoningService.processText as jest.Mock).mockRejectedValueOnce(new Error('offline'));

    await runActionOverEdit();

    expect(savedEnhanced()).toEqual(['## Edited']);
  });
});

describe('NoteEditorScreen switching notes', () => {
  it('closes an open speaker sheet when another note opens', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { getByText, queryByTestId, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByText('Alice can take the first pass.'));
    const buttons = (alertSpy.mock.calls[0][2] ?? []) as { text: string; onPress?: () => void }[];
    act(() => {
      buttons.find((button) => button.text === 'Rename')?.onPress?.();
    });
    expect(queryByTestId('speaker-rename-sheet')).toBeTruthy();

    mockRouteNoteId = '8';
    mockNote = note({ id: 8 });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    expect(queryByTestId('speaker-rename-sheet')).toBeNull();
    alertSpy.mockRestore();
  });
});

describe('NoteEditorScreen transcript sheet', () => {
  it('opens the full transcript from View Transcript', () => {
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('transcript-sheet')).toBeNull();

    fireEvent.press(getByTestId('menu-view-transcript'));

    expect(getByTestId('transcript-sheet').props.children).toContain(
      'Alice can take the first pass.',
    );
  });

  it('offers View Transcript before notes are generated too', () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('menu-view-transcript')).toBeTruthy();
  });

  it('has no View Transcript on a plain note', () => {
    mockNote = note({
      noteType: 'personal',
      diarizationEnabled: 0,
      calendarEventId: null,
      participants: null,
    });
    mockNotesState.notes = [mockNote];
    mockSegments = [];
    const { queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('menu-view-transcript')).toBeNull();
  });
});

describe('NoteEditorScreen meta row', () => {
  beforeEach(() => {
    mockNotesState.folders = [
      {
        id: 1,
        name: 'Meetings',
        isDefault: 0,
        sortOrder: 0,
        spaceId: 1,
        clientFolderId: null,
        remoteId: null,
        deletedAt: null,
        pendingSync: 0,
        createdAt: null,
        updatedAt: null,
      } as Folder,
    ];
  });
  afterEach(() => {
    mockNotesState.folders = [];
    mockNotesState.spaces = [];
  });

  it('shows the attendees and folder of a calendar meeting', () => {
    const { getByTestId, getByText } = render(<NoteEditorScreen />);
    expect(getByTestId('note-meta-attendees')).toBeTruthy();
    expect(getByText('Alice')).toBeTruthy();
    expect(getByText('Meetings')).toBeTruthy();
  });

  it('opens the folder picker from the folder chip', () => {
    const { getByTestId, queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('move-sheet')).toBeNull();
    fireEvent.press(getByTestId('note-meta-folder'));
    expect(getByTestId('move-sheet')).toBeTruthy();
  });

  it('lists the attendees from the attendees chip', () => {
    const { getByTestId, getByText } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-meta-attendees'));
    expect(getByText('Attendees')).toBeTruthy();
    expect(getByText('Alice Adams')).toBeTruthy();
  });

  it('hides the attendees chip on a note without attendees', () => {
    mockNote = note({ calendarEventId: null, participants: null });
    mockNotesState.notes = [mockNote];
    const { queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('note-meta-attendees')).toBeNull();
  });

  it('offers no folders for a note whose Space is not on this device', () => {
    mockNote = note({ spaceId: 99 });
    mockNotesState.notes = [mockNote];
    const { queryByTestId, queryByText } = render(<NoteEditorScreen />);
    expect(queryByTestId('note-meta-folder')).toBeNull();
    expect(queryByText('Meetings')).toBeNull();
  });

  it('closes the folder picker if the note’s Space disappears while it is open', () => {
    mockNote = note({ spaceId: 1 });
    mockNotesState.notes = [mockNote];
    mockNotesState.spaces = [{ id: 1, kind: 'private', name: 'Private' } as Space];
    const { getByTestId, queryByTestId, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-meta-folder'));
    expect(getByTestId('move-sheet')).toBeTruthy();

    mockNotesState.spaces = [];
    rerender(<NoteEditorScreen />);
    expect(queryByTestId('move-sheet')).toBeNull();

    // It stays closed when the Space comes back.
    mockNotesState.spaces = [{ id: 1, kind: 'private', name: 'Private' } as Space];
    rerender(<NoteEditorScreen />);
    expect(queryByTestId('move-sheet')).toBeNull();
  });

  it('closes the folder picker when another note opens', () => {
    const { getByTestId, queryByTestId, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('note-meta-folder'));
    expect(getByTestId('move-sheet')).toBeTruthy();

    mockRouteNoteId = '8';
    mockNote = note({ id: 8 });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    expect(queryByTestId('move-sheet')).toBeNull();
  });

  describe('on a team note', () => {
    const teamSpace = { id: 2, kind: 'team', name: 'Engineering', workspaceId: 'w1' } as Space;
    const participants = JSON.stringify([
      {
        email: 'sam@example.com',
        displayName: 'Sam Lee',
        responseStatus: 'accepted',
        organizer: true,
        resource: false,
        self: true,
      },
      {
        email: 'user@example.com',
        displayName: 'Uma User',
        responseStatus: 'accepted',
        organizer: false,
        resource: false,
        self: false,
      },
    ]);
    beforeEach(() => {
      mockNotesState.spaces = [teamSpace];
    });

    it('labels you, not the teammate who created the note, as You', () => {
      mockNote = note({ spaceId: 2, ownerUserId: 'teammate-9', participants });
      mockNotesState.notes = [mockNote];
      const { getByTestId, getByText, queryByText } = render(<NoteEditorScreen />);
      expect(getByText('Sam +1')).toBeTruthy();

      fireEvent.press(getByTestId('note-meta-attendees'));
      expect(getByText('Sam Lee')).toBeTruthy();
      expect(getByText('You')).toBeTruthy();
      expect(queryByText('Uma User')).toBeNull();
    });

    it('labels you, not the teammate who created the note, as You while its Space is unknown', () => {
      mockNotesState.spaces = [];
      mockNote = note({ spaceId: 2, ownerUserId: 'teammate-9', participants });
      mockNotesState.notes = [mockNote];
      const { getByTestId, getByText, queryByText } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('note-meta-attendees'));
      expect(getByText('Sam Lee')).toBeTruthy();
      expect(getByText('You')).toBeTruthy();
      expect(queryByText('Uma User')).toBeNull();
    });

    it('trusts your calendar’s own row on a team note you created', () => {
      // Your calendar account needn't share your OpenWhispr address.
      const ownCalendar = JSON.stringify([
        {
          email: 'uma@corp.example',
          displayName: 'Uma User',
          responseStatus: 'accepted',
          organizer: false,
          resource: false,
          self: true,
        },
        {
          email: 'sam@example.com',
          displayName: 'Sam Lee',
          responseStatus: 'accepted',
          organizer: false,
          resource: false,
          self: false,
        },
      ]);
      mockNote = note({ spaceId: 2, ownerUserId: 'user-1', participants: ownCalendar });
      mockNotesState.notes = [mockNote];
      const { getByTestId, getByText, queryByText } = render(<NoteEditorScreen />);
      expect(getByText('Sam +1')).toBeTruthy();
      fireEvent.press(getByTestId('note-meta-attendees'));
      expect(getByText('You')).toBeTruthy();
      expect(queryByText('Uma User')).toBeNull();
    });
  });

  it('dates a note pulled before its creation time synced by its last edit, not the pull', () => {
    mockNote = note({ createdAt: '2025-09-27 08:00:00', updatedAt: '2025-06-26T12:00:00.000Z' });
    mockNotesState.notes = [mockNote];
    const { getByText, queryByText } = render(<NoteEditorScreen />);
    expect(getByText(/^Jun 26, 2025/)).toBeTruthy();
    expect(queryByText(/^Sep 27, 2025/)).toBeNull();
  });

  it('keeps that date after the note is edited on this device', () => {
    mockNote = note({
      createdAt: '2025-09-27 08:00:00',
      updatedAt: '2025-09-28 10:00:00',
      cloudUpdatedAt: '2025-06-26T12:00:00.000Z',
    });
    mockNotesState.notes = [mockNote];
    const { getByText, queryByText } = render(<NoteEditorScreen />);
    expect(getByText(/^Jun 26, 2025/)).toBeTruthy();
    expect(queryByText(/^Sep 27, 2025/)).toBeNull();
  });
});

describe('NoteEditorScreen clearing generated notes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the editor open when the generated notes are cleared mid-edit', () => {
    jest.useFakeTimers();
    mockNote = note({ enhancedContent: '## Summary' });
    mockNotesState.notes = [mockNote];
    const { getByTestId, rerender } = render(<NoteEditorScreen />);

    fireEvent.press(getByTestId('enhanced-edit'));
    fireEvent.changeText(getByTestId('enhanced-editor'), '');
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(mockUpdateNote).toHaveBeenCalledWith(7, { enhancedContent: '' });

    // The store now holds the cleared notes.
    mockNote = note({ enhancedContent: '' });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    fireEvent.changeText(getByTestId('enhanced-editor'), '## Rewritten');
    fireEvent.press(getByTestId('enhanced-done'));
    expect(mockUpdateNote).toHaveBeenLastCalledWith(7, { enhancedContent: '## Rewritten' });
  });
});

describe('NoteEditorScreen voice setup', () => {
  let alertSpy: jest.SpyInstance;
  const longSegments = (): Segment[] => [
    segment({
      id: 20,
      speakerLabel: 'speaker_0',
      startMs: 0,
      endMs: 15000,
      text: 'I will own the launch.',
    }),
  ];

  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockNote = note({ sourceFile: 'managed://meeting-7.wav', transcriptionStatus: 'done' });
    mockNotesState.notes = [mockNote];
    mockSegments = longSegments();
    mockSpeakers = [speaker()];
    mockNotesState.meetingSpeakerEmbeddingsByNoteId = { 7: { speaker_0: [0.1, 0.2] } };
  });
  afterEach(() => alertSpy.mockRestore());

  it('offers voice setup on a meeting recorded on this device', () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    expect(getByTestId('voice-setup-banner')).toBeTruthy();
  });

  it('loads your voice profiles, which a meeting opened straight from recording never did', () => {
    render(<NoteEditorScreen />);
    expect(mockLoadVoiceProfiles).toHaveBeenCalled();
  });

  it('does not offer it on a meeting recorded elsewhere, or once you have a profile', () => {
    mockNote = note({ sourceFile: null });
    mockNotesState.notes = [mockNote];
    const { queryByTestId, rerender } = render(<NoteEditorScreen />);
    expect(queryByTestId('voice-setup-banner')).toBeNull();

    mockNote = note({ sourceFile: 'managed://meeting-7.wav' });
    mockNotesState.notes = [mockNote];
    mockNotesState.voiceProfiles = [{ id: 1, isOwner: 1 } as SpeakerProfile];
    rerender(<NoteEditorScreen />);
    expect(queryByTestId('voice-setup-banner')).toBeNull();
  });

  it("doesn't offer it once this meeting's samples are gone, such as after a restart", () => {
    mockNotesState.meetingSpeakerEmbeddingsByNoteId = {};
    const { queryByTestId } = render(<NoteEditorScreen />);
    expect(queryByTestId('voice-setup-banner')).toBeNull();
  });

  it('waits for settings to load, so a dismissed banner never flashes', () => {
    const loaded = mockConfigState.config;
    mockConfigState.config = null as unknown as Partial<UserConfig>;
    try {
      const { queryByTestId } = render(<NoteEditorScreen />);
      expect(queryByTestId('voice-setup-banner')).toBeNull();
    } finally {
      mockConfigState.config = loaded;
    }
  });

  it('hides the banner for good when dismissed, under its own setting', () => {
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-dismiss'));
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      voiceSetupBannerDismissedAt: expect.any(String),
    });
  });

  it('still shows for someone who dismissed the old notes-list card', () => {
    (mockConfigState.config as Record<string, unknown>).voiceProfilePromptDismissedAt =
      '2026-09-01T00:00:00.000Z';
    try {
      const { getByTestId } = render(<NoteEditorScreen />);
      expect(getByTestId('voice-setup-banner')).toBeTruthy();
    } finally {
      delete (mockConfigState.config as Record<string, unknown>).voiceProfilePromptDismissedAt;
    }
  });

  it('makes the tapped speaker your voice', () => {
    const { getByTestId, getByText } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    fireEvent.press(getByTestId('thats-me-10'));

    expect(mockClaimSpeakerAsMe).toHaveBeenCalledWith(7, 10);
    expect(getByText('Got it')).toBeTruthy();
  });

  it('explains and keeps the script offer when the sample is gone', () => {
    mockClaimSpeakerAsMe.mockImplementationOnce(() => {
      throw new Error("This meeting's voice sample is no longer available.");
    });
    const { getByTestId, queryByText } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    fireEvent.press(getByTestId('thats-me-10'));

    expect(alertSpy).toHaveBeenCalledWith(
      "Couldn't save your voice",
      'Read a short script instead to teach OpenWhispr your voice.',
    );
    expect(queryByText('Got it')).toBeNull();
    expect(getByTestId('thats-me-read-script')).toBeTruthy();
  });

  it("doesn't suggest the script when you already have a voice profile", () => {
    const { SpeakerProfileOwnerAlreadyExistsError } = jest.requireActual(
      '@/data/local/notesRepository',
    );
    mockClaimSpeakerAsMe.mockImplementationOnce(() => {
      throw new SpeakerProfileOwnerAlreadyExistsError();
    });
    const { getByTestId } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    fireEvent.press(getByTestId('thats-me-10'));

    expect(alertSpy).toHaveBeenCalledWith(
      "You've already taught OpenWhispr your voice",
      'Open it in Voice Profiles and choose Retrain Voice.',
    );
    // Reloading picks up the profile, which hides the banner.
    expect(mockLoadVoiceProfiles).toHaveBeenCalledTimes(2);
  });

  it('opens the script for this meeting once the sheet has finished closing', () => {
    const { getByTestId, UNSAFE_getAllByType } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    const sheet = UNSAFE_getAllByType(Modal).find(
      (modal) => modal.props.presentationStyle === 'pageSheet' && modal.props.visible,
    );
    fireEvent.press(getByTestId('thats-me-read-script'));

    // Pushing while the sheet slides away gets dropped on iOS.
    expect(mockPush).not.toHaveBeenCalled();
    act(() => sheet?.props.onDismiss());

    expect(mockPush).toHaveBeenCalledWith('/(tabs)/(notes)/voice-enrollment?owner=1&noteId=7');
  });

  it('opens the script right away on Android, which has no sheet onDismiss', () => {
    const platform = Platform.OS;
    Platform.OS = 'android';
    try {
      const { getByTestId } = render(<NoteEditorScreen />);
      fireEvent.press(getByTestId('voice-setup-banner-set-up'));
      fireEvent.press(getByTestId('thats-me-read-script'));

      expect(mockPush).toHaveBeenCalledWith('/(tabs)/(notes)/voice-enrollment?owner=1&noteId=7');
    } finally {
      Platform.OS = platform;
    }
  });

  it("doesn't open the script for another note after switching mid-close", () => {
    const { getByTestId, UNSAFE_getAllByType, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    const sheet = UNSAFE_getAllByType(Modal).find(
      (modal) => modal.props.presentationStyle === 'pageSheet' && modal.props.visible,
    );
    fireEvent.press(getByTestId('thats-me-read-script'));

    mockRouteNoteId = '8';
    mockNote = note({ id: 8, sourceFile: 'managed://meeting-8.wav' });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);
    act(() => sheet?.props.onDismiss());

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('closes the sheet when another note opens', () => {
    const { getByTestId, queryByTestId, rerender } = render(<NoteEditorScreen />);
    fireEvent.press(getByTestId('voice-setup-banner-set-up'));
    expect(getByTestId('thats-me-sheet')).toBeTruthy();

    mockRouteNoteId = '8';
    mockNote = note({ id: 8, sourceFile: 'managed://meeting-8.wav' });
    mockNotesState.notes = [mockNote];
    rerender(<NoteEditorScreen />);

    expect(queryByTestId('thats-me-sheet')).toBeNull();
  });
});
