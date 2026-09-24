import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import NoteEditorScreen from '@/screens/NoteEditorScreen';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { generateNoteTitle } from '@/utils/generateTitle';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { makeContentHash } from '@/lib/utils';
import type { Action, Note, Segment, Speaker } from '@/data/types';

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
  getConflictedNote: jest.fn(() => null),
  resolveConflictKeepMine: jest.fn(),
  resolveConflictUseServer: jest.fn(),
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
  updateConfig: mockUpdateConfig,
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
  NoteActionsMenu: ({
    actions,
    onRunAction,
  }: {
    actions: Action[];
    onRunAction: (action: Action) => void;
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
  SpeakerTranscript: ({ blocks }: { blocks: { text: string }[] }) =>
    (() => {
      const { Text: MockText, View: MockView } = require('react-native');
      return (
        <MockView>
          {blocks.map((block, index) => (
            <MockText key={index}>{block.text}</MockText>
          ))}
        </MockView>
      );
    })(),
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
  mockActions = [defaultAction()];
  mockActionsState.actions = mockActions;
  mockNote = note();
  mockNotesState.notes = [mockNote];
  mockSegments = [segment()];
  mockSpeakers = [speaker()];
  mockConfigState.config.autoGenerateNoteTitle = false;
  mockConfigState.config.appleLocalIntelligenceEnabled = true;
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
