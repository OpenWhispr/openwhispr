jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///app/documents/' }));
const mockProcessMeeting = jest.fn();
const mockGetDiarizer = jest.fn();
const mockLocalTranscribe = jest.fn();
const mockGenerateNoteTitle = jest.fn();
const mockDeriveLocalTitle = jest.fn();
const mockPromptLocalReasoningFallback = jest.fn();
const mockLogTranscriptionCompleted = jest.fn();
const mockAuthState: { user: { id: string; email: string; emailVerified: boolean } | null } = {
  user: null,
};
const mockConfigState: {
  config: {
    autoGenerateNoteTitle: boolean;
    appleLocalIntelligenceEnabled?: boolean;
    inference?: { notes?: { mode: 'local' } };
  };
} = {
  config: { autoGenerateNoteTitle: false },
};
const mockProcessingModeState: { activeMode: 'cloud' | 'private' } = {
  activeMode: 'cloud',
};

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
}));
jest.mock('@/data/remote/notesApi', () => ({
  deleteNote: jest.fn(),
}));
jest.mock('@/lib/uuid', () => ({
  randomUUID: () => 'test-uuid',
}));
jest.mock('@/data', () => ({
  notesRepository: {
    // A meeting note is created in the private space, so its folder is resolved
    // from the private-space folders only — never a team space's "Meetings".
    getPrivateFolders: jest.fn(() => [
      { id: 2, name: 'Meetings', isDefault: 1, sortOrder: 1, deletedAt: null },
      { id: 1, name: 'Personal', isDefault: 1, sortOrder: 0, deletedAt: null },
    ]),
    getFolders: jest.fn(() => []),
    createNote: jest.fn(() => ({ id: 7, title: 'Untitled meeting', noteType: 'meeting' })),
    getNoteById: jest.fn(() => null),
    updateNote: jest.fn(),
    updateNoteMeta: jest.fn(),
    updateNoteCalendarContext: jest.fn(),
    setNotePrivacy: jest.fn(),
    clearNoteRemoteId: jest.fn(),
    clearNoteClientId: jest.fn(),
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    clearSyncState: jest.fn(),
    getTranscriptionStatus: jest.fn(() => 'idle'),
    setTranscriptionStatus: jest.fn(),
    getSegments: jest.fn(() => []),
    replaceSegments: jest.fn(),
    getSpeakers: jest.fn(() => []),
    getActions: jest.fn(() => []),
    updateSpeaker: jest.fn(),
    mergeSpeakers: jest.fn(),
    getSpeakerProfiles: jest.fn(() => []),
    getSpeakerProfileById: jest.fn(() => null),
    createSpeakerProfile: jest.fn(),
    createOwnerProfileForSpeaker: jest.fn(),
    updateSpeakerProfile: jest.fn(),
    deleteSpeakerProfile: jest.fn(),
    deleteAllSpeakerProfiles: jest.fn(),
  },
  spacesRepository: {
    getPrivateSpace: jest.fn(() => ({ id: 1, kind: 'private' })),
    listSpaces: jest.fn(() => [
      { id: 1, kind: 'private' },
      { id: 3, kind: 'team' },
    ]),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => mockProcessingModeState },
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => mockAuthState, subscribe: () => () => {} },
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: { getState: () => mockConfigState, subscribe: () => () => {} },
}));
jest.mock('@/utils/generateTitle', () => ({
  generateNoteTitle: mockGenerateNoteTitle,
  deriveLocalTitle: mockDeriveLocalTitle,
}));
jest.mock('@/lib/localReasoningFallback', () => ({
  promptLocalReasoningFallback: (...args: unknown[]) => mockPromptLocalReasoningFallback(...args),
}));
jest.mock('@/lib/appsflyer', () => ({
  logTranscriptionCompleted: (...args: unknown[]) => mockLogTranscriptionCompleted(...args),
}));
jest.mock('@/services/reasoning/ReasoningService', () => ({
  ReasoningService: {
    processText: jest.fn(),
  },
}));
jest.mock('@/lib/notes/localMeetingNotes', () => ({
  generateLocalMeetingNotes: jest.fn(),
}));
jest.mock('@/services/diarization/DiarizationService', () => ({
  processMeeting: mockProcessMeeting,
}));
jest.mock('@/lib/diarization/getDiarizer', () => ({
  getDiarizer: mockGetDiarizer,
}));
jest.mock('@/services/transcription/LocalTranscriptionService', () => ({
  LocalTranscriptionService: {
    transcribe: mockLocalTranscribe,
    isAvailable: jest.fn(() => true),
    isReadyForLanguage: jest.fn(async () => true),
  },
}));

import { useNotesStore } from '../useNotesStore';
import { notesRepository, spacesRepository } from '@/data';
import { ReasoningService } from '@/services/reasoning/ReasoningService';
import { generateLocalMeetingNotes } from '@/lib/notes/localMeetingNotes';
import * as localReasoning from '@/lib/localReasoning';
import type { Speaker } from '@/data/types';
import { SpeakerProfileOwnerAlreadyExistsError } from '@/data/local/notesRepository';
import * as Sentry from '@sentry/react-native';

const speaker = (overrides: Partial<Speaker>): Speaker =>
  ({
    id: 1,
    noteId: 7,
    speakerLabel: 'SPEAKER_00',
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

const segment = (text: string) => ({
  id: 20,
  noteId: 7,
  startMs: 0,
  endMs: 2000,
  text,
  speakerLabel: 'speaker_0',
  sortOrder: 0,
  clientId: null,
  remoteId: null,
  deletedAt: null,
  pendingSync: 1,
  createdAt: null,
  updatedAt: null,
});

const signedInUser = { id: 'user-1', email: 'user@example.com', emailVerified: true };

beforeEach(() => {
  // loadNotes/loadFolders read SQLite; stub them on the store for these unit tests.
  useNotesStore.setState({
    folders: [],
    loadNotes: () => {},
    loadFolders: () => {},
    transcriptRevision: 0,
    meetingSpeakerEmbeddingsByNoteId: {},
  });
  jest.clearAllMocks();
  mockAuthState.user = null;
  mockConfigState.config.autoGenerateNoteTitle = false;
  delete mockConfigState.config.appleLocalIntelligenceEnabled;
  delete mockConfigState.config.inference;
  mockProcessingModeState.activeMode = 'cloud';
  mockProcessMeeting.mockResolvedValue({ speakerEmbeddingsByLabel: { speaker_0: [1, 0] } });
  mockGenerateNoteTitle.mockResolvedValue('Generated meeting title');
  mockDeriveLocalTitle.mockReturnValue('Local fallback title');
  (ReasoningService.processText as jest.Mock).mockResolvedValue({
    text: 'Generated meeting notes',
    model: 'test',
  });
  mockGetDiarizer.mockReturnValue({
    diarize: jest.fn(),
    isModelDownloaded: jest.fn(async () => true),
    downloadModel: jest.fn(async () => undefined),
    deleteModel: jest.fn(async () => undefined),
  });
  mockLocalTranscribe.mockResolvedValue({
    text: '',
    duration: 0,
    provider: 'local',
    segments: [],
  });
  (notesRepository.getTranscriptionStatus as jest.Mock).mockReturnValue('idle');
  (notesRepository.getPrivateFolders as jest.Mock).mockReturnValue([
    { id: 2, name: 'Meetings', isDefault: 1, sortOrder: 1, deletedAt: null },
    { id: 1, name: 'Personal', isDefault: 1, sortOrder: 0, deletedAt: null },
  ]);
  (notesRepository.createNote as jest.Mock).mockReturnValue({
    id: 7,
    title: 'Untitled meeting',
    noteType: 'meeting',
  });
  (notesRepository.getNoteById as jest.Mock).mockReturnValue(null);
  (notesRepository.getActions as jest.Mock).mockReturnValue([]);
  (notesRepository.getSpeakers as jest.Mock).mockReturnValue([]);
  (notesRepository.getSpeakerProfiles as jest.Mock).mockReturnValue([]);
  (notesRepository.getSpeakerProfileById as jest.Mock).mockReturnValue(null);
});

describe('createMeetingNote', () => {
  it('stamps meeting meta (no status) and sets recording via the guarded boundary', () => {
    const note = useNotesStore.getState().createMeetingNote(3);
    expect(note.id).toBe(7);
    expect(notesRepository.createNote).toHaveBeenCalledWith('Untitled meeting', '', 2);
    expect(notesRepository.updateNoteMeta).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        noteType: 'meeting',
        diarizationEnabled: 1,
        expectedSpeakerCount: 3,
      }),
    );
    expect(notesRepository.updateNoteCalendarContext).not.toHaveBeenCalled();
    // status is NOT written via updateNoteMeta — it goes through the guarded transitionStatus
    expect(notesRepository.updateNoteMeta).not.toHaveBeenCalledWith(
      7,
      expect.objectContaining({ transcriptionStatus: expect.anything() }),
    );
    expect(notesRepository.setTranscriptionStatus).toHaveBeenCalledWith(7, 'recording');
  });

  it('falls back when the Meetings folder is missing', () => {
    (notesRepository.getPrivateFolders as jest.Mock).mockReturnValue([
      { id: 1, name: 'Personal', isDefault: 1, sortOrder: 0, deletedAt: null },
    ]);

    useNotesStore.getState().createMeetingNote();

    expect(notesRepository.createNote).toHaveBeenCalledWith('Untitled meeting', '', 1);
  });

  describe('started from a folder or space', () => {
    const PERSONAL_FOLDER = { id: 5, name: 'Clients', spaceId: 1, deletedAt: null };
    const TEAM_FOLDER = { id: 9, name: 'Team', spaceId: 3, deletedAt: null };
    const getFolders = notesRepository.getFolders as jest.Mock;
    const getPrivateFolders = notesRepository.getPrivateFolders as jest.Mock;
    const defaultGetFolders = getFolders.getMockImplementation();
    const defaultGetPrivateFolders = getPrivateFolders.getMockImplementation();

    beforeEach(() => {
      getFolders.mockReturnValue([PERSONAL_FOLDER, TEAM_FOLDER]);
      getPrivateFolders.mockReturnValue([
        { id: 2, name: 'Meetings', isDefault: 1, sortOrder: 1, spaceId: 1, deletedAt: null },
        PERSONAL_FOLDER,
      ]);
    });

    // clearAllMocks keeps implementations, so the folders above would leak into later tests.
    afterEach(() => {
      getFolders.mockImplementation(defaultGetFolders);
      getPrivateFolders.mockImplementation(defaultGetPrivateFolders);
    });

    it('files the meeting in the folder it was started from', () => {
      useNotesStore.getState().createMeetingNote({ folderId: 5 });
      expect(notesRepository.createNote).toHaveBeenCalledWith('Untitled meeting', '', 5);
    });

    it("files it in a team space's folder, or in the space itself with no folder open", () => {
      useNotesStore.getState().createMeetingNote({ folderId: 9 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 9);

      useNotesStore.getState().createMeetingNote({ spaceId: 3 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith(
        'Untitled meeting',
        '',
        undefined,
        3,
      );
    });

    it('keeps a Private-mode meeting out of team spaces, in Meetings', () => {
      mockProcessingModeState.activeMode = 'private';

      useNotesStore.getState().createMeetingNote({ folderId: 9 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
      useNotesStore.getState().createMeetingNote({ spaceId: 3 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
      useNotesStore.getState().createMeetingNote({ folderId: 5 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 5);
    });

    it('uses Meetings when the team space is unknown, gone, or not a number', () => {
      useNotesStore.getState().createMeetingNote({ spaceId: 404 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
      useNotesStore.getState().createMeetingNote({ spaceId: Number('abc') });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);

      // Access to space 3 was removed while its screen was still open.
      (spacesRepository.listSpaces as jest.Mock).mockReturnValueOnce([{ id: 1, kind: 'private' }]);
      useNotesStore.getState().createMeetingNote({ spaceId: 3 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
      (spacesRepository.listSpaces as jest.Mock).mockReturnValueOnce([{ id: 1, kind: 'private' }]);
      useNotesStore.getState().createMeetingNote({ folderId: 9 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
    });

    it('uses Meetings when the folder is gone, or the space is the personal one', () => {
      useNotesStore.getState().createMeetingNote({ folderId: 404 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
      useNotesStore.getState().createMeetingNote({ spaceId: 1 });
      expect(notesRepository.createNote).toHaveBeenLastCalledWith('Untitled meeting', '', 2);
    });
  });

  it('persists selected calendar context locally', () => {
    const participants = [
      {
        email: 'alice@example.com',
        displayName: 'Alice',
        responseStatus: 'accepted' as const,
        optional: false,
        organizer: false,
        resource: false,
        self: false,
      },
    ];

    useNotesStore.getState().createMeetingNote({
      expectedSpeakerCount: 2,
      calendarEventId: 'calendar-event-context',
      title: 'Customer Planning',
      participants,
    });

    expect(notesRepository.createNote).toHaveBeenCalledWith('Customer Planning', '', 2);
    expect(notesRepository.updateNoteMeta).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        noteType: 'meeting',
        diarizationEnabled: 1,
        expectedSpeakerCount: 2,
      }),
    );
    expect(notesRepository.updateNoteCalendarContext).toHaveBeenCalledWith(7, {
      calendarEventId: 'calendar-event-context',
      participants: JSON.stringify(participants),
    });
  });

  it('stores empty participant arrays for selected events with no attendees', () => {
    useNotesStore.getState().createMeetingNote({
      calendarEventId: 'calendar-event-context',
      title: '   ',
      participants: [],
    });

    expect(notesRepository.createNote).toHaveBeenCalledWith('Untitled meeting', '', 2);
    expect(notesRepository.updateNoteCalendarContext).toHaveBeenCalledWith(7, {
      calendarEventId: 'calendar-event-context',
      participants: '[]',
    });
  });
});

describe('transitionStatus (guarded boundary)', () => {
  it('throws on an illegal jump and never writes', () => {
    (notesRepository.getTranscriptionStatus as jest.Mock).mockReturnValue('idle');
    expect(() => useNotesStore.getState().transitionStatus(7, 'done')).toThrow(/Illegal/);
    expect(notesRepository.setTranscriptionStatus).not.toHaveBeenCalled();
  });
});

describe('finalizeCloudMeeting', () => {
  it('generates notes without exposing an unknown speaker label', async () => {
    mockAuthState.user = signedInUser;
    (notesRepository.getTranscriptionStatus as jest.Mock)
      .mockReturnValueOnce('recording')
      .mockReturnValueOnce('transcribing');
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Planning Sync',
      content: '',
      noteType: 'meeting',
      diarizationEnabled: 0,
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
      calendarEventId: null,
      participants: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      {
        id: 1,
        name: 'Generate Notes',
        description: 'Turn rough dictation into clean, structured notes',
        prompt: 'Transform this meeting into notes.',
        isDefault: 1,
        sortOrder: 0,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([
      {
        ...segment('Ship the onboarding fix.'),
        speakerLabel: null,
      },
    ]);
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([]);

    await useNotesStore.getState().finalizeCloudMeeting(
      7,
      [
        {
          itemId: 'utterance-1',
          text: 'Ship the onboarding fix.',
          startMs: 0,
          endMs: 2000,
        },
      ],
      2,
    );

    expect(notesRepository.replaceSegments).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([expect.objectContaining({ speakerLabel: null })]),
    );
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.text).toContain(
      'Meeting transcript:\nPlanning Sync\n\n[0:00] Ship the onboarding fix.',
    );
    expect(request.text).not.toContain('Unknown speaker');
    expect(request.systemPrompt).toContain('Never output "Unknown speaker"');
    expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({
      source: 'meeting',
      provider: 'cloud',
    });
  });

  it('does not log an empty cloud meeting transcription', async () => {
    (notesRepository.getTranscriptionStatus as jest.Mock)
      .mockReturnValueOnce('recording')
      .mockReturnValueOnce('transcribing');

    await useNotesStore.getState().finalizeCloudMeeting(7, [], 0);

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('does not log when cloud meeting persistence fails', async () => {
    (notesRepository.getTranscriptionStatus as jest.Mock).mockReturnValueOnce('recording');
    (notesRepository.replaceSegments as jest.Mock).mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(
      useNotesStore
        .getState()
        .finalizeCloudMeeting(
          7,
          [{ itemId: 'utterance-1', text: 'Transcript', startMs: 0, endMs: 1000 }],
          1,
        ),
    ).rejects.toThrow('database unavailable');

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });
});

describe('runMeetingPipeline', () => {
  it('logs a persisted local meeting transcription', async () => {
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Transcript')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({
      source: 'meeting',
      provider: 'local',
    });
  });

  it('does not log when local meeting transcription fails', async () => {
    mockProcessMeeting.mockRejectedValueOnce(new Error('transcription failed'));

    await expect(
      useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2),
    ).rejects.toThrow('transcription failed');

    expect(mockLogTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('runs identification after processing and increments transcriptRevision', async () => {
    (notesRepository.getSpeakerProfiles as jest.Mock).mockReturnValue([
      {
        id: 99,
        displayName: 'Me',
        email: null,
        isOwner: 1,
        embedding: [1, 0],
        sampleCount: 1,
        consentAt: '2026-06-19T12:00:00.000Z',
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, speakerLabel: 'speaker_0' }),
    ]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(notesRepository.updateNoteMeta).toHaveBeenCalledWith(7, {
      sourceFile: 'file://meeting.wav',
    });
    expect(mockProcessMeeting).toHaveBeenCalledWith(
      { noteId: 7, wavUri: 'file://meeting.wav', expectedSpeakerCount: 2, language: undefined },
      expect.objectContaining({ repo: notesRepository }),
    );
    expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        displayName: 'Me',
        profileId: 99,
        speakerStatus: 'confirmed',
      }),
    );
    expect(useNotesStore.getState().transcriptRevision).toBe(1);
  });

  it('does not increment transcriptRevision when identification applies no writes', async () => {
    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(useNotesStore.getState().transcriptRevision).toBe(0);
  });

  it('retries a failed meeting from its retained source file', async () => {
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Failed meeting',
      noteType: 'meeting',
      sourceFile: 'file:///app/documents/meeting-7.wav',
      expectedSpeakerCount: 3,
      deletedAt: null,
      participants: null,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Recovered transcript')]);

    await useNotesStore.getState().retryMeetingTranscription(7);

    expect(notesRepository.updateNoteMeta).toHaveBeenCalledWith(7, {
      sourceFile: 'file:///app/documents/meeting-7.wav',
    });
    expect(mockProcessMeeting).toHaveBeenCalledWith(
      {
        noteId: 7,
        wavUri: 'file:///app/documents/meeting-7.wav',
        expectedSpeakerCount: 3,
        language: undefined,
      },
      expect.objectContaining({ repo: notesRepository }),
    );
    expect(mockLogTranscriptionCompleted).toHaveBeenCalledWith({
      source: 'meeting',
      provider: 'local',
    });
  });

  it('does not replace a selected calendar title with transcript auto-title', async () => {
    mockAuthState.user = signedInUser;
    mockConfigState.config.autoGenerateNoteTitle = true;
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      calendarEventId: 'calendar-event-context',
      noteType: 'meeting',
      deletedAt: null,
      isPrivate: 0,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Discuss launch risks.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockGenerateNoteTitle).not.toHaveBeenCalled();
    expect(mockDeriveLocalTitle).not.toHaveBeenCalled();
    expect(notesRepository.updateNote).not.toHaveBeenCalledWith(7, {
      title: expect.any(String),
    });
  });

  it('allows transcript auto-title after a calendar note is cleared to the default title', async () => {
    mockAuthState.user = signedInUser;
    mockConfigState.config.autoGenerateNoteTitle = true;
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Untitled meeting',
      calendarEventId: 'calendar-event-context',
      noteType: 'meeting',
      deletedAt: null,
      isPrivate: 0,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Discuss launch risks.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockGenerateNoteTitle).toHaveBeenCalledWith('Discuss launch risks.', {
      allowCloudFallback: true,
      isPrivateNote: false,
    });
    expect(notesRepository.updateNote).toHaveBeenCalledWith(7, {
      title: 'Generated meeting title',
    });
  });

  it('derives the title locally in private mode and never sends transcript to the cloud', async () => {
    mockAuthState.user = signedInUser;
    mockProcessingModeState.activeMode = 'private';
    mockConfigState.config.autoGenerateNoteTitle = true;
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Untitled meeting',
      noteType: 'meeting',
      deletedAt: null,
      isPrivate: 0,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Discuss launch risks.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockGenerateNoteTitle).not.toHaveBeenCalled();
    expect(ReasoningService.processText).not.toHaveBeenCalled();
    expect(mockDeriveLocalTitle).toHaveBeenCalledWith('Discuss launch risks.');
    expect(notesRepository.updateNote).toHaveBeenCalledWith(7, {
      title: 'Local fallback title',
    });
  });

  it('derives the title locally for notes marked private even in cloud mode', async () => {
    mockAuthState.user = signedInUser;
    mockConfigState.config.autoGenerateNoteTitle = true;
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Untitled meeting',
      noteType: 'meeting',
      deletedAt: null,
      isPrivate: 1,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Discuss launch risks.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockGenerateNoteTitle).not.toHaveBeenCalled();
    expect(ReasoningService.processText).not.toHaveBeenCalled();
    expect(mockDeriveLocalTitle).toHaveBeenCalledWith('Discuss launch risks.');
    expect(notesRepository.updateNote).toHaveBeenCalledWith(7, {
      title: 'Local fallback title',
    });
  });

  it('derives the title locally when signed out instead of making a doomed cloud call', async () => {
    mockConfigState.config.autoGenerateNoteTitle = true;
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Untitled meeting',
      noteType: 'meeting',
      deletedAt: null,
      isPrivate: 0,
    });
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Discuss launch risks.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(mockGenerateNoteTitle).not.toHaveBeenCalled();
    expect(mockDeriveLocalTitle).toHaveBeenCalledWith('Discuss launch risks.');
    expect(notesRepository.updateNote).toHaveBeenCalledWith(7, {
      title: 'Local fallback title',
    });
  });

  it('auto-generates enhanced notes from the finished meeting transcript', async () => {
    mockAuthState.user = { id: 'user-1', email: 'user@example.com', emailVerified: true };
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Planning Sync',
      content: 'Customer launch risk came up twice. Prioritize onboarding.',
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      {
        id: 1,
        name: 'Generate Notes',
        description: 'Turn rough dictation into clean, structured notes',
        prompt: 'Transform this meeting into notes.',
        isDefault: 1,
        sortOrder: 0,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([
      {
        id: 20,
        noteId: 7,
        startMs: 0,
        endMs: 2000,
        text: 'We need to ship the onboarding fix.',
        speakerLabel: 'speaker_0',
        sortOrder: 0,
        clientId: null,
        remoteId: null,
        deletedAt: null,
        pendingSync: 1,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, speakerLabel: 'speaker_0' }),
    ]);
    (ReasoningService.processText as jest.Mock).mockResolvedValue({
      text: 'Summary\n\n## Action Items\n- [ ] Speaker 1: Ship the onboarding fix.',
      model: 'test',
    });

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(ReasoningService.processText).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining('professional meeting notes assistant'),
        temperature: 0.3,
      }),
    );
    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.text).toContain(
      'Raw notes captured during the meeting:\nCustomer launch risk came up twice. Prioritize onboarding.',
    );
    expect(request.text).not.toContain('Calendar context');
    expect(request.text).toContain('[0:00] Speaker 1: We need to ship the onboarding fix.');
    expect(notesRepository.updateNote).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        enhancedContent: 'Summary\n\n## Action Items\n- [ ] Speaker 1: Ship the onboarding fix.',
        enhancementPrompt: 'Transform this meeting into notes.',
        enhancedAtContentHash: expect.any(String),
      }),
    );
  });

  describe('with generated notes already on the note', () => {
    const meetingNote = (enhancedContent: string | null) => ({
      id: 7,
      title: 'Planning Sync',
      content: 'Prioritize onboarding.',
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedContent,
      enhancedAtContentHash: null,
    });

    beforeEach(() => {
      mockAuthState.user = signedInUser;
      (notesRepository.getActions as jest.Mock).mockReturnValue([
        { id: 1, name: 'Generate Notes', prompt: 'Transform this meeting.', isDefault: 1 },
      ]);
      (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Ship the fix.')]);
      (ReasoningService.processText as jest.Mock).mockResolvedValue({
        text: 'Fresh notes',
        model: 'test',
      });
    });

    const wroteGeneratedNotes = (): boolean =>
      (notesRepository.updateNote as jest.Mock).mock.calls.some(
        ([, updates]) => updates.enhancedContent !== undefined,
      );

    it('keeps notes the user already has instead of generating over them', async () => {
      (notesRepository.getNoteById as jest.Mock).mockReturnValue(meetingNote('## My edited notes'));

      await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

      expect(ReasoningService.processText).not.toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.3 }),
      );
      expect(wroteGeneratedNotes()).toBe(false);
    });

    it('drops the generated notes when the user wrote some while they were being made', async () => {
      let current = meetingNote(null);
      (notesRepository.getNoteById as jest.Mock).mockImplementation(() => current);
      (ReasoningService.processText as jest.Mock).mockImplementation(async () => {
        current = meetingNote('## Written meanwhile');
        return { text: 'Fresh notes', model: 'test' };
      });

      await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

      expect(ReasoningService.processText).toHaveBeenCalled();
      expect(wroteGeneratedNotes()).toBe(false);
    });
  });

  it('writes On-Device meeting notes through the chunked local path when signed in', async () => {
    mockAuthState.user = signedInUser;
    mockConfigState.config.inference = { notes: { mode: 'local' } };
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Planning Sync',
      content: '',
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      { id: 1, name: 'Generate Notes', prompt: 'Transform this meeting.', isDefault: 1 },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Ship the fix.')]);
    (generateLocalMeetingNotes as jest.Mock).mockResolvedValue('Local notes');
    jest
      .spyOn(localReasoning, 'getLocalReasoningReadiness')
      .mockResolvedValueOnce({ status: 'ready', tokenCounting: false });

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(generateLocalMeetingNotes).toHaveBeenCalledWith(7, {
      actionPrompt: 'Transform this meeting.',
    });
    expect(ReasoningService.processText).not.toHaveBeenCalled();
    expect(notesRepository.updateNote).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ enhancedContent: 'Local notes' }),
    );
  });

  it('still offers to enable local AI when On-Device notes cannot run yet', async () => {
    mockConfigState.config.inference = { notes: { mode: 'local' } };
    mockConfigState.config.appleLocalIntelligenceEnabled = false;
    mockProcessingModeState.activeMode = 'private';
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Planning Sync',
      content: '',
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      { id: 1, name: 'Generate Notes', prompt: 'Transform this meeting.', isDefault: 1 },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([segment('Ship the fix.')]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(generateLocalMeetingNotes).not.toHaveBeenCalled();
    expect(mockPromptLocalReasoningFallback).toHaveBeenCalled();
  });

  it('prompts before using cloud fallback when local auto meeting notes are unavailable', async () => {
    mockAuthState.user = signedInUser;
    mockConfigState.config.appleLocalIntelligenceEnabled = false;
    mockProcessingModeState.activeMode = 'private';
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Planning Sync',
      content: 'Customer launch risk came up twice. Prioritize onboarding.',
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      {
        id: 1,
        name: 'Generate Notes',
        description: 'Turn rough dictation into clean, structured notes',
        prompt: 'Transform this meeting into notes.',
        isDefault: 1,
        sortOrder: 0,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([
      segment('We need to ship the onboarding fix.'),
    ]);
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, speakerLabel: 'speaker_0' }),
    ]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    expect(ReasoningService.processText).not.toHaveBeenCalled();
    expect(mockPromptLocalReasoningFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        signedIn: true,
        onEnableLocal: expect.any(Function),
        onUseCloudOnce: expect.any(Function),
      }),
    );

    const promptOptions = mockPromptLocalReasoningFallback.mock.calls[0][0] as {
      onUseCloudOnce: () => Promise<void>;
    };
    await promptOptions.onUseCloudOnce();

    expect(ReasoningService.processText).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({
          allowCloudFallback: true,
          isPrivateNote: false,
        }),
      }),
    );
    expect(notesRepository.updateNote).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        enhancedContent: 'Generated meeting notes',
        enhancementPrompt: 'Transform this meeting into notes.',
      }),
    );
  });

  it('includes selected calendar context when auto-generating meeting notes', async () => {
    mockAuthState.user = { id: 'user-1', email: 'user@example.com', emailVerified: true };
    const participants = [
      {
        email: 'alice@example.com',
        displayName: 'Alice Adams',
        responseStatus: 'accepted' as const,
        optional: false,
        organizer: false,
        resource: false,
        self: false,
      },
      {
        email: 'declined@example.com',
        displayName: 'Declined Person',
        responseStatus: 'declined' as const,
        optional: false,
        organizer: false,
        resource: false,
        self: false,
      },
    ];
    (notesRepository.getNoteById as jest.Mock).mockReturnValue({
      id: 7,
      title: 'Customer Planning',
      content: 'Alice owns the launch checklist.',
      calendarEventId: 'calendar-event-context',
      participants: JSON.stringify(participants),
      noteType: 'meeting',
      isPrivate: 0,
      deletedAt: null,
      enhancedAtContentHash: null,
    });
    (notesRepository.getActions as jest.Mock).mockReturnValue([
      {
        id: 1,
        name: 'Generate Notes',
        description: 'Turn rough dictation into clean, structured notes',
        prompt: 'Transform this meeting into notes.',
        isDefault: 1,
        sortOrder: 0,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSegments as jest.Mock).mockReturnValue([
      {
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
        pendingSync: 1,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, speakerLabel: 'speaker_0' }),
    ]);

    await useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);

    const request = (ReasoningService.processText as jest.Mock).mock.calls[0][0];
    expect(request.text).toContain(
      'Calendar context (for interpretation only; do not list this context automatically):',
    );
    expect(request.text).toContain('Event title: Customer Planning');
    expect(request.text).toContain('Possible participant hints: Alice Adams <alice@example.com>');
    expect(request.text).not.toContain('Meeting transcript:\nCustomer Planning');
    expect(request.text).not.toContain('Declined Person');
    expect(request.systemPrompt).toContain(
      'Do not list attendees just because they were provided.',
    );
  });
});

describe('voice profile enrollment', () => {
  const enrollmentInput = {
    recordings: [{ uri: 'file://take1.wav', mimeType: 'audio/wav' }],
    consentAccepted: true,
    consentAcceptedAt: '2026-06-19T12:00:00.000Z',
  };

  it('requires a downloaded diarizer model before processing enrollment audio', async () => {
    mockGetDiarizer.mockReturnValueOnce({
      diarize: jest.fn(),
      isModelDownloaded: jest.fn(async () => false),
      downloadModel: jest.fn(async () => undefined),
    });

    await expect(
      useNotesStore.getState().enrollVoiceProfile(enrollmentInput),
    ).rejects.toMatchObject({
      code: 'VOICE_ENROLLMENT_DIARIZER_MODEL_REQUIRED',
    });

    expect(notesRepository.createSpeakerProfile).not.toHaveBeenCalled();
  });

  it('downloads the diarizer model only through the explicit download action', async () => {
    const downloadModel = jest.fn(async () => undefined);
    mockGetDiarizer.mockReturnValueOnce({
      diarize: jest.fn(),
      isModelDownloaded: jest.fn(async () => false),
      downloadModel,
    });

    await useNotesStore.getState().downloadDiarizerModel();

    expect(downloadModel).toHaveBeenCalledTimes(1);
  });

  it('shares one model download between callers and is not ready until it finishes', async () => {
    let finish: () => void = () => {};
    const downloadModel = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mockGetDiarizer.mockReturnValue({
      diarize: jest.fn(),
      isModelDownloaded: jest.fn(async () => true),
      downloadModel,
    });

    const first = useNotesStore.getState().downloadDiarizerModel();
    const second = useNotesStore.getState().downloadDiarizerModel();
    await expect(useNotesStore.getState().isDiarizerModelReady()).resolves.toBe(false);
    finish();
    await Promise.all([first, second]);

    expect(downloadModel).toHaveBeenCalledTimes(1);
    await expect(useNotesStore.getState().isDiarizerModelReady()).resolves.toBe(true);
  });

  it('waits for a speaker-model download already running before diarizing a meeting', async () => {
    let finish: () => void = () => {};
    const diarize = jest.fn(async (_wavUri: string, _count?: number) => ({
      segments: [],
      embeddings: {},
    }));
    mockGetDiarizer.mockReturnValue({
      diarize,
      isModelDownloaded: jest.fn(async () => false),
      downloadModel: jest.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    mockProcessMeeting.mockImplementation(
      async (_input: unknown, deps: { diarizer: { diarize: typeof diarize } }) => {
        await deps.diarizer.diarize('file://meeting.wav', 2);
        return { speakerEmbeddingsByLabel: {} };
      },
    );

    const download = useNotesStore.getState().downloadDiarizerModel();
    expect(useNotesStore.getState().isDiarizerModelDownloading()).toBe(true);
    const pipeline = useNotesStore.getState().runMeetingPipeline(7, 'file://meeting.wav', 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(diarize).not.toHaveBeenCalled();

    finish();
    await download;
    await pipeline;
    expect(diarize).toHaveBeenCalledWith('file://meeting.wav', 2);
    expect(useNotesStore.getState().isDiarizerModelDownloading()).toBe(false);
  });

  it('deletes the diarizer model through the explicit delete action', async () => {
    const deleteModel = jest.fn(async () => undefined);
    mockGetDiarizer.mockReturnValueOnce({
      diarize: jest.fn(),
      isModelDownloaded: jest.fn(async () => true),
      downloadModel: jest.fn(async () => undefined),
      deleteModel,
    });

    await useNotesStore.getState().deleteDiarizerModel();

    expect(deleteModel).toHaveBeenCalledTimes(1);
  });
});

describe('speaker mutations', () => {
  it('renameSpeaker writes locked fields from speakerState', () => {
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, displayName: 'Alice', speakerLocked: 0 }),
    ]);

    useNotesStore.getState().renameSpeaker(7, 10, ' Alice Cooper ');

    expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(10, {
      displayName: 'Alice Cooper',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
    });
  });

  it('blank rename does not call the repository', () => {
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, displayName: 'Alice' }),
    ]);

    useNotesStore.getState().renameSpeaker(7, 10, '   ');

    expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
  });

  it('mergeSpeakers calls repository with a speakerState-derived target patch', () => {
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice' }),
      speaker({
        id: 11,
        speakerLabel: 'SPEAKER_01',
        displayName: 'Bob',
        speakerStatus: 'confirmed',
      }),
    ]);

    useNotesStore.getState().mergeSpeakers(7, 10, 11);

    expect(notesRepository.mergeSpeakers).toHaveBeenCalledWith(7, 10, 11, {
      displayName: 'Bob',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
    });
  });

  it('rename and merge increment transcriptRevision', () => {
    (notesRepository.getSpeakers as jest.Mock)
      .mockReturnValueOnce([speaker({ id: 10, displayName: 'Alice' })])
      .mockReturnValueOnce([
        speaker({ id: 10, speakerLabel: 'SPEAKER_00', displayName: 'Alice' }),
        speaker({ id: 11, speakerLabel: 'SPEAKER_01', displayName: 'Bob' }),
      ]);

    useNotesStore.getState().renameSpeaker(7, 10, 'Alicia');
    expect(useNotesStore.getState().transcriptRevision).toBe(1);

    useNotesStore.getState().mergeSpeakers(7, 10, 11);
    expect(useNotesStore.getState().transcriptRevision).toBe(2);
  });

  it('confirmSpeakerSuggestion locks the speaker and learns from the current meeting embedding', () => {
    (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
      speaker({
        id: 10,
        speakerLabel: 'speaker_0',
        displayName: 'Alice?',
        profileId: 99,
        speakerStatus: 'suggested',
      }),
    ]);
    (notesRepository.getSpeakerProfileById as jest.Mock).mockReturnValue({
      id: 99,
      displayName: 'Alice',
      email: null,
      isOwner: 0,
      embedding: [1, 0],
      sampleCount: 1,
      consentAt: '2026-06-19T12:00:00.000Z',
      createdAt: null,
      updatedAt: null,
    });
    useNotesStore.setState({
      meetingSpeakerEmbeddingsByNoteId: { 7: { speaker_0: [0, 1] } },
      transcriptRevision: 0,
    });

    useNotesStore.getState().confirmSpeakerSuggestion(7, 10);

    expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(10, {
      displayName: 'Alice',
      speakerStatus: 'locked',
      speakerLocked: 1,
      speakerLockSource: 'user',
      profileId: 99,
    });
    expect(notesRepository.updateSpeakerProfile).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ sampleCount: 2 }),
    );
    const profilePatch = (notesRepository.updateSpeakerProfile as jest.Mock).mock.calls[0][1];
    expect(profilePatch.embedding[0]).toBeCloseTo(Math.SQRT1_2);
    expect(profilePatch.embedding[1]).toBeCloseTo(Math.SQRT1_2);
    expect(useNotesStore.getState().transcriptRevision).toBe(1);
  });

  it('rejectSpeakerSuggestion clears tentative state without touching locked speakers', () => {
    (notesRepository.getSpeakers as jest.Mock).mockReturnValueOnce([
      speaker({
        id: 10,
        displayName: 'Alice',
        profileId: 99,
        speakerStatus: 'suggested',
      }),
    ]);

    useNotesStore.getState().rejectSpeakerSuggestion(7, 10);

    expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(10, {
      displayName: null,
      profileId: null,
      speakerStatus: 'provisional',
      speakerLocked: 0,
      speakerLockSource: null,
    });

    (notesRepository.updateSpeaker as jest.Mock).mockClear();
    (notesRepository.getSpeakers as jest.Mock).mockReturnValueOnce([
      speaker({
        id: 11,
        displayName: 'Locked Alice',
        profileId: 99,
        speakerStatus: 'locked',
        speakerLocked: 1,
        speakerLockSource: 'user',
      }),
    ]);

    useNotesStore.getState().rejectSpeakerSuggestion(7, 11);

    expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
  });

  describe('claimSpeakerAsMe', () => {
    let profiles: Array<Record<string, unknown>>;
    let rows: Speaker[];
    const ownerProfile = {
      id: 3,
      displayName: 'Me',
      isOwner: 1,
      email: null,
      embedding: [0.6, 0.8],
      sampleCount: 1,
    };

    beforeEach(() => {
      profiles = [];
      useNotesStore.setState({
        meetingSpeakerEmbeddingsByNoteId: { 7: { SPEAKER_01: [3, 4] } },
      });
      (notesRepository.getTranscriptionStatus as jest.Mock).mockReturnValue('done');
      (notesRepository.getSpeakerProfiles as jest.Mock).mockImplementation(() => profiles);
      rows = [speaker({ id: 10, speakerLabel: 'SPEAKER_01' })];
      (notesRepository.getSpeakers as jest.Mock).mockImplementation(() => rows);
      // Like the repository: the claimed speaker comes back locked to the new profile.
      (notesRepository.createOwnerProfileForSpeaker as jest.Mock).mockImplementation(
        (speakerId: number, _input: unknown, patch: Partial<Speaker>) => {
          profiles = [ownerProfile];
          rows = rows.map((row) =>
            row.id === speakerId ? { ...row, ...patch, profileId: ownerProfile.id } : row,
          );
          return ownerProfile;
        },
      );
    });

    it('creates your profile and links the speaker in a single atomic write', () => {
      useNotesStore.getState().claimSpeakerAsMe(7, 10);

      expect(notesRepository.createOwnerProfileForSpeaker).toHaveBeenCalledWith(
        10,
        {
          displayName: 'Me',
          // Stored normalized, like a guided-read sample.
          embedding: [0.6, 0.8],
          sampleCount: 1,
          consentAt: expect.any(String),
        },
        {
          displayName: 'Me',
          speakerStatus: 'locked',
          speakerLocked: 1,
          speakerLockSource: 'user',
        },
      );
      expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
      expect(useNotesStore.getState().voiceProfiles).toEqual([ownerProfile]);
      expect(useNotesStore.getState().transcriptRevision).toBe(1);
    });

    it('labels another speaker in the same meeting who has your voice', () => {
      useNotesStore.setState({
        meetingSpeakerEmbeddingsByNoteId: { 7: { SPEAKER_01: [3, 4], SPEAKER_02: [3, 4] } },
      });
      rows = [
        speaker({ id: 10, speakerLabel: 'SPEAKER_01' }),
        speaker({ id: 11, speakerLabel: 'SPEAKER_02', sortOrder: 1 }),
      ];

      useNotesStore.getState().claimSpeakerAsMe(7, 10);

      expect(notesRepository.updateSpeaker).toHaveBeenCalledTimes(1);
      expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(
        11,
        expect.objectContaining({ displayName: 'Me', profileId: 3 }),
      );
    });

    it("leaves a speaker linked to someone else's profile, or a rejected suggestion, alone", () => {
      const bob = { id: 4, displayName: 'Bob', isOwner: 0, email: null, embedding: [0, 1] };
      profiles = [bob];
      useNotesStore.setState({
        meetingSpeakerEmbeddingsByNoteId: {
          7: { SPEAKER_01: [3, 4], SPEAKER_02: [3, 4], SPEAKER_03: [0, 1] },
        },
      });
      rows = [
        speaker({ id: 10, speakerLabel: 'SPEAKER_01' }),
        // Auto-labelled Bob, though the voice matches yours.
        speaker({
          id: 11,
          speakerLabel: 'SPEAKER_02',
          sortOrder: 1,
          displayName: 'Bob',
          profileId: 4,
          speakerStatus: 'confirmed',
        }),
        // You rejected "Bob?" here; claiming must not suggest Bob again.
        speaker({ id: 12, speakerLabel: 'SPEAKER_03', sortOrder: 2 }),
      ];
      (notesRepository.createOwnerProfileForSpeaker as jest.Mock).mockImplementation(
        (speakerId: number, _input: unknown, patch: Partial<Speaker>) => {
          profiles = [bob, ownerProfile];
          rows = rows.map((row) =>
            row.id === speakerId ? { ...row, ...patch, profileId: ownerProfile.id } : row,
          );
          return ownerProfile;
        },
      );

      useNotesStore.getState().claimSpeakerAsMe(7, 10);

      expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
    });

    it('keeps the claim when labelling the rest of the meeting fails', () => {
      const failure = new Error('disk full');
      (notesRepository.updateSpeaker as jest.Mock).mockImplementationOnce(() => {
        throw failure;
      });
      useNotesStore.setState({
        meetingSpeakerEmbeddingsByNoteId: { 7: { SPEAKER_01: [3, 4], SPEAKER_02: [3, 4] } },
      });
      rows = [
        speaker({ id: 10, speakerLabel: 'SPEAKER_01' }),
        speaker({ id: 11, speakerLabel: 'SPEAKER_02', sortOrder: 1 }),
      ];

      expect(() => useNotesStore.getState().claimSpeakerAsMe(7, 10)).not.toThrow();

      expect(useNotesStore.getState().voiceProfiles).toEqual([ownerProfile]);
      expect(Sentry.captureException).toHaveBeenCalledWith(failure, expect.anything());
    });

    it('refuses without writing when you already have a profile', () => {
      profiles = [{ id: 1, isOwner: 1 }];

      expect(() => useNotesStore.getState().claimSpeakerAsMe(7, 10)).toThrow(
        SpeakerProfileOwnerAlreadyExistsError,
      );
      expect(notesRepository.createOwnerProfileForSpeaker).not.toHaveBeenCalled();
    });

    it('refuses without writing while the meeting is being processed again', () => {
      (notesRepository.getTranscriptionStatus as jest.Mock).mockReturnValue('diarizing');

      expect(() => useNotesStore.getState().claimSpeakerAsMe(7, 10)).toThrow();
      expect(notesRepository.createOwnerProfileForSpeaker).not.toHaveBeenCalled();
    });

    it.each([
      ['gone', {}],
      ['unusable', { 7: { SPEAKER_01: [0, 0] } }],
    ])('refuses without writing when the meeting sample is %s', (_label, embeddings) => {
      useNotesStore.setState({ meetingSpeakerEmbeddingsByNoteId: embeddings });

      expect(() => useNotesStore.getState().claimSpeakerAsMe(7, 10)).toThrow();
      expect(notesRepository.createOwnerProfileForSpeaker).not.toHaveBeenCalled();
    });

    it('refuses when the speaker is not on the note', () => {
      expect(() => useNotesStore.getState().claimSpeakerAsMe(7, 99)).toThrow();
      expect(notesRepository.createOwnerProfileForSpeaker).not.toHaveBeenCalled();
    });
  });

  describe('relabelMeetingSpeakers', () => {
    beforeEach(() => {
      (notesRepository.getSpeakerProfiles as jest.Mock).mockReturnValue([
        { id: 3, displayName: 'Me', isOwner: 1, email: null, embedding: [0.6, 0.8] },
      ]);
      (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
        speaker({ id: 10, speakerLabel: 'SPEAKER_01' }),
      ]);
    });

    it('labels a meeting still held in memory with a newly added voice', () => {
      useNotesStore.setState({ meetingSpeakerEmbeddingsByNoteId: { 7: { SPEAKER_01: [3, 4] } } });

      useNotesStore.getState().relabelMeetingSpeakers(7, 3);

      expect(notesRepository.updateSpeaker).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ displayName: 'Me', profileId: 3 }),
      );
      expect(useNotesStore.getState().transcriptRevision).toBe(1);
    });

    it('does nothing for a meeting whose samples are gone', () => {
      useNotesStore.setState({ meetingSpeakerEmbeddingsByNoteId: {} });

      useNotesStore.getState().relabelMeetingSpeakers(7, 3);

      expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
      expect(useNotesStore.getState().transcriptRevision).toBe(0);
    });

    it('writes nothing when the speaker already has the new label', () => {
      useNotesStore.setState({ meetingSpeakerEmbeddingsByNoteId: { 7: { SPEAKER_01: [3, 4] } } });
      (notesRepository.getSpeakers as jest.Mock).mockReturnValue([
        speaker({
          id: 10,
          speakerLabel: 'SPEAKER_01',
          displayName: 'Me',
          profileId: 3,
          speakerStatus: 'confirmed',
        }),
      ]);

      useNotesStore.getState().relabelMeetingSpeakers(7, 3);

      expect(notesRepository.updateSpeaker).not.toHaveBeenCalled();
      expect(useNotesStore.getState().transcriptRevision).toBe(0);
    });
  });
});

it('does not open a synced source_file that is not the recording owned by this note', async () => {
  const mockRepository = jest.mocked(notesRepository);
  mockRepository.getNoteById.mockReturnValue({
    id: 7,
    sourceFile: 'file:///app/documents/SQLite/app.db',
  } as NonNullable<ReturnType<typeof notesRepository.getNoteById>>);
  await expect(useNotesStore.getState().retryMeetingTranscription(7)).rejects.toThrow(
    'Original audio',
  );
  expect(mockProcessMeeting).not.toHaveBeenCalled();
});

it('retains remote deletion retry identifiers when making a note private fails offline', async () => {
  const { deleteNote } = jest.requireMock('@/data/remote/notesApi');
  const mockRepository = jest.mocked(notesRepository);
  mockRepository.getNoteById.mockReturnValue({
    id: 1,
    remoteId: 'remote',
    clientNoteId: 'client',
    isPrivate: 1,
  } as NonNullable<ReturnType<typeof notesRepository.getNoteById>>);
  deleteNote.mockRejectedValueOnce(new Error('offline'));
  await expect(useNotesStore.getState().setNotePrivacy(1, true)).rejects.toThrow('offline');
  expect(notesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
  expect(notesRepository.clearNoteClientId).not.toHaveBeenCalled();
});
