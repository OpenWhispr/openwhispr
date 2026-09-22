// The real apiClient.ts pulls in expo/fetch + useAuthStore (which pulls in
// better-auth, an ESM-only package jest can't transform). Mock a lightweight
// stand-in for ApiError instead — same approach as AccountScreen.billing.test.tsx.
jest.mock('@/lib/apiClient', () => ({
  ApiError: class MockApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly data?: unknown;

    constructor(message: string, status: number, code?: string, data?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.data = data;
    }
  },
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getPendingNotes: jest.fn(),
    getNoteById: jest.fn(),
    getFolders: jest.fn(),
    hardDeleteNote: jest.fn(),
    markNotePushed: jest.fn(),
    markNoteTerminal: jest.fn(),
    parkNoteConflict: jest.fn(),
    clearNoteRemoteId: jest.fn(),
    hasDirtyTranscript: jest.fn(),
    getSegments: jest.fn(),
    getSpeakers: jest.fn(),
    markTranscriptPushed: jest.fn(),
    forkNoteToPrivate: jest.fn(),
    dropNotePushAttempt: jest.fn(),
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    clearSyncState: jest.fn(),
  },
  spacesRepository: {
    listSpaces: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  batchCreateNotes: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
}));

import { pushNotes } from '../pushNotes';
import { notesRepository, spacesRepository } from '@/data';
import {
  batchCreateNotes,
  updateNote as updateNoteRemote,
  deleteNote,
} from '@/data/remote/notesApi';
import * as Sentry from '@sentry/react-native';
import { serializeSegmentsForSync } from '@/lib/notes/remoteTranscript';
import { ApiError } from '@/lib/apiClient';
import type { Note, Segment, Speaker } from '@/data/types';
import type { Space } from '@/data';

const mockNotesRepository = notesRepository as jest.Mocked<typeof notesRepository>;
const mockListSpaces = spacesRepository.listSpaces as jest.Mock;
const mockBatchCreateNotes = batchCreateNotes as jest.Mock;
const mockUpdateNoteRemote = updateNoteRemote as jest.Mock;
const mockDeleteNote = deleteNote as jest.Mock;
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;
const mockCaptureException = Sentry.captureException as jest.Mock;
const mockAddBreadcrumb = Sentry.addBreadcrumb as jest.Mock;

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 1,
    title: 'Planning Sync',
    content: 'Discuss launch.',
    folderId: 2,
    noteType: 'meeting',
    sourceFile: null,
    audioDurationSeconds: null,
    enhancedContent: null,
    enhancementPrompt: null,
    enhancedAtContentHash: null,
    diarizationEnabled: 1,
    expectedSpeakerCount: null,
    transcriptionStatus: 'idle',
    calendarEventId: null,
    participants: null,
    clientNoteId: 'client-note-1',
    remoteId: null,
    deletedAt: null,
    pendingSync: 1,
    isPrivate: 0,
    createdAt: '2026-06-26T09:00:00.000Z',
    updatedAt: '2026-06-26T10:00:00.000Z',
    ...overrides,
  }) as Note;

beforeEach(() => {
  mockNotesRepository.getNoteById.mockImplementation((id) => {
    const pending = mockNotesRepository.getPendingNotes.mock.results.at(-1)?.value as
      | Note[]
      | undefined;
    return pending?.find((row) => row.id === id) ?? null;
  });
});

describe('pushNotes calendar context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([
      {
        id: 2,
        name: 'Meetings',
        isDefault: 0,
        sortOrder: 0,
        clientFolderId: 'client-folder-2',
        remoteId: 'remote-folder-2',
        deletedAt: null,
        pendingSync: 0,
        spaceId: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockBatchCreateNotes.mockResolvedValue([]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-1',
      updated_at: '2026-06-26T11:00:00.000Z',
    });
  });

  it('pushes public create calendar context and handles id-only batch responses', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        calendarEventId: '{"eventId":"event-1"}',
        participants: '[{"email":"alice@example.com"}]',
      }),
    ]);
    mockBatchCreateNotes.mockResolvedValue([
      {
        id: 'remote-note-1',
        client_note_id: 'client-note-1',
      },
    ]);

    await pushNotes();

    expect(mockBatchCreateNotes).toHaveBeenCalledWith([
      expect.objectContaining({
        client_note_id: 'client-note-1',
        calendar_event_id: '{"eventId":"event-1"}',
        participants: '[{"email":"alice@example.com"}]',
        folder_id: 'remote-folder-2',
      }),
    ]);
    // The mocked batch-create response omits updated_at (id-only), so the 3rd
    // arg (local bookkeeping) falls back to the note's own updatedAt, but the
    // 4th arg (cloudUpdatedAt, the sync base) must be explicit null — see the
    // dedicated Task 5 fix-round test for why (a local-clock base would false-
    // 409-park this row on its very next edit).
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'remote-note-1',
      '2026-06-26T10:00:00.000Z',
      null,
    );
  });

  it('pushes public update calendar context', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        remoteId: 'remote-note-1',
        calendarEventId: '{"eventId":"event-1"}',
        participants: '[]',
      }),
    ]);

    await pushNotes();

    expect(mockUpdateNoteRemote).toHaveBeenCalledWith(
      'remote-note-1',
      expect.objectContaining({
        calendar_event_id: '{"eventId":"event-1"}',
        participants: '[]',
        folder_id: 'remote-folder-2',
      }),
    );
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'remote-note-1',
      '2026-06-26T11:00:00.000Z',
    );
  });

  it('does not upload private notes with calendar context', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        isPrivate: 1,
        calendarEventId: '{"eventId":"private-event"}',
        participants: '[{"email":"private@example.com"}]',
      }),
    ]);

    await pushNotes();

    expect(mockBatchCreateNotes).not.toHaveBeenCalled();
    expect(mockUpdateNoteRemote).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'pushNotes: blocked private note id=1',
      'fatal',
    );
  });
});

describe('pushNotes transcript', () => {
  const segment = (over: Partial<Segment>): Segment =>
    ({
      id: 10,
      noteId: 1,
      startMs: 0,
      endMs: 0,
      text: 'hello',
      speakerLabel: 'speaker_0',
      sortOrder: 0,
      clientId: null,
      remoteId: null,
      deletedAt: null,
      pendingSync: 1,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as Segment;

  const speaker = (over: Partial<Speaker>): Speaker =>
    ({
      id: 20,
      noteId: 1,
      speakerLabel: 'speaker_0',
      displayName: 'Alice',
      profileId: null,
      color: null,
      sortOrder: 0,
      speakerStatus: null,
      speakerLocked: 0,
      speakerLockSource: null,
      clientId: null,
      remoteId: null,
      deletedAt: null,
      pendingSync: 1,
      createdAt: null,
      updatedAt: null,
      ...over,
    }) as Speaker;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockBatchCreateNotes.mockResolvedValue([]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-1',
      updated_at: '2026-06-26T11:00:00.000Z',
    });
  });

  it('sends serialized transcript on update when local segments are dirty', async () => {
    const segments = [segment({})];
    const speakers = [speaker({})];
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(true);
    mockNotesRepository.getSegments.mockReturnValue(segments);
    mockNotesRepository.getSpeakers.mockReturnValue(speakers);
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ remoteId: 'remote-note-1', folderId: null }),
    ]);

    await pushNotes();

    const expectedRaw = serializeSegmentsForSync(segments, speakers);
    expect(mockUpdateNoteRemote).toHaveBeenCalledWith(
      'remote-note-1',
      expect.objectContaining({ transcript: expectedRaw }),
    );
    expect(mockNotesRepository.markTranscriptPushed).toHaveBeenCalledWith(
      1,
      expectedRaw,
      [10],
      [20],
    );
  });

  it('omits the transcript key on update when segments are clean', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ remoteId: 'remote-note-1', folderId: null, transcript: 'stored-raw' }),
    ]);

    await pushNotes();

    const payload = mockUpdateNoteRemote.mock.calls[0][1];
    expect('transcript' in payload).toBe(false);
    expect(mockNotesRepository.markTranscriptPushed).not.toHaveBeenCalled();
  });

  it('echoes the stored raw transcript on create so batch-create does not null it', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ remoteId: null, folderId: null, transcript: 'stored-raw' }),
    ]);
    mockBatchCreateNotes.mockResolvedValue([
      { id: 'remote-note-1', client_note_id: 'client-note-1' },
    ]);

    await pushNotes();

    expect(mockBatchCreateNotes).toHaveBeenCalledWith([
      expect.objectContaining({ transcript: 'stored-raw' }),
    ]);
  });
});

describe('pushNotes terminal error classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
  });

  it('400 on create clears pendingSync for every row in the batch and does not throw', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, clientNoteId: 'client-note-1', folderId: null }),
      note({ id: 2, remoteId: null, clientNoteId: 'client-note-2', folderId: null }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(new ApiError('Payload rejected', 400));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledWith(2);
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'warning' }),
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('400 on update clears pendingSync for that note and does not throw', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Payload rejected', 400));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'warning' }),
    );
  });

  it('404 on update clears remoteId, keeps pendingSync, and does not throw', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Not found', 404));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.clearNoteRemoteId).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(ApiError),
      expect.objectContaining({ tags: { sync: 'pushNotes.update.404' } }),
    );
  });

  it('409 on create keeps current retry behavior (counts as failure, no terminal handling)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, clientNoteId: 'client-note-1', folderId: null }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(new ApiError('Conflict', 409));

    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(ApiError),
      expect.objectContaining({ tags: { sync: 'pushNotes.create' } }),
    );
  });

  it('500 on update keeps current retry behavior (counts as failure, no terminal handling)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Server error', 500));

    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(ApiError),
      expect.objectContaining({ tags: { sync: 'pushNotes.update' } }),
    );
  });
});

describe('pushNotes base_updated_at / 409 note_version_conflict (Task 5)', () => {
  const serverNote = {
    id: 'remote-note-1',
    client_note_id: 'client-note-1',
    title: 'Edited elsewhere',
    content: 'Someone else changed this on another device.',
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
    updated_at: '2026-08-24T12:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
  });

  it('includes base_updated_at on update when the row has a cloud_updated_at', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        remoteId: 'remote-note-1',
        folderId: null,
        cloudUpdatedAt: '2026-06-26T09:30:00.000Z',
      }),
    ]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-1',
      updated_at: '2026-06-26T11:00:00.000Z',
    });

    await pushNotes();

    expect(mockUpdateNoteRemote).toHaveBeenCalledWith(
      'remote-note-1',
      expect.objectContaining({ base_updated_at: '2026-06-26T09:30:00.000Z' }),
    );
  });

  it('omits base_updated_at on update when the row has no cloud_updated_at (pre-feature row)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ remoteId: 'remote-note-1', folderId: null, cloudUpdatedAt: null }),
    ]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-1',
      updated_at: '2026-06-26T11:00:00.000Z',
    });

    await pushNotes();

    const payload = mockUpdateNoteRemote.mock.calls[0][1];
    expect('base_updated_at' in payload).toBe(false);
  });

  it('fix round 1 (finding 3): a create response without updated_at leaves cloudUpdatedAt null, so the next edit does not send a stale base and cannot false-409', async () => {
    // Part 1: an older backend's batch-create response omits updated_at.
    mockNotesRepository.getPendingNotes.mockReturnValueOnce([
      note({ id: 1, remoteId: null, clientNoteId: 'client-note-1', folderId: null }),
    ]);
    mockBatchCreateNotes.mockResolvedValueOnce([
      { id: 'remote-note-1', client_note_id: 'client-note-1' },
    ]);

    await pushNotes();

    // Local bookkeeping (3rd arg) may fall back to the local clock, but the
    // 4th arg (cloudUpdatedAt, the sync base) must be explicit null — never
    // that same local-clock fallback.
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'remote-note-1',
      expect.any(String),
      null,
    );

    // Part 2: simulate the resulting row (cloudUpdatedAt stayed null) coming
    // up for its next edit — base_updated_at must be omitted entirely, not
    // sent as a stale local-clock value the server would reject with a false
    // 409 note_version_conflict.
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValueOnce([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null, cloudUpdatedAt: null }),
    ]);
    mockUpdateNoteRemote.mockResolvedValueOnce({
      id: 'remote-note-1',
      updated_at: '2026-06-27T00:00:00.000Z',
    });

    await pushNotes();

    const payload = mockUpdateNoteRemote.mock.calls[0][1];
    expect('base_updated_at' in payload).toBe(false);
  });

  it('409 note_version_conflict parks the row: pendingSync untouched, conflict stashed, batch does not fail', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        cloudUpdatedAt: '2026-06-26T09:00:00.000Z',
      }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(
      new ApiError('Note was edited elsewhere', 409, 'note_version_conflict', { note: serverNote }),
    );

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.parkNoteConflict).toHaveBeenCalledWith(1, serverNote);
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'warning' }),
    );
  });

  it('409 WITHOUT note_version_conflict code stays retryable (existing failure behavior)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Conflict', 409));

    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.parkNoteConflict).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(ApiError),
      expect.objectContaining({ tags: { sync: 'pushNotes.update' } }),
    );
  });

  it('409 note_version_conflict with no data.note falls back to the retryable path', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(
      new ApiError('Note was edited elsewhere', 409, 'note_version_conflict'),
    );

    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.parkNoteConflict).not.toHaveBeenCalled();
  });
});

describe('pushNotes create batching (PUSH_BATCH_SIZE)', () => {
  // Builds `count` distinct pending-create notes (localId/clientNoteId 1..count).
  // The server rejects batch-create bodies over 50 notes, so any count above
  // 50 must split into more than one request.
  const manyCreates = (count: number): Note[] =>
    Array.from({ length: count }, (_, idx) =>
      note({
        id: idx + 1,
        remoteId: null,
        clientNoteId: `client-note-${idx + 1}`,
        folderId: null,
      }),
    );

  const serverRowFor = (localId: number) => ({
    id: `remote-note-${localId}`,
    client_note_id: `client-note-${localId}`,
    updated_at: `2026-08-24T10:00:${String(localId).padStart(2, '0')}.000Z`,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
  });

  it('splits more than 50 pending creates into multiple batch-create requests', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue(manyCreates(62));
    mockBatchCreateNotes.mockImplementation(async (items: { client_note_id: string }[]) =>
      // Reverse the response order within each request to prove matching is by
      // client_note_id, not position, even inside a single chunk's response.
      [...items].reverse().map((i) => serverRowFor(Number(i.client_note_id.split('-')[2]))),
    );

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).toHaveBeenCalledTimes(2);
    expect(mockBatchCreateNotes.mock.calls[0][0]).toHaveLength(50);
    expect(mockBatchCreateNotes.mock.calls[1][0]).toHaveLength(12);
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(62);
    // Spot-check a row from each chunk resolves to its own (not a neighbor's) remote id.
    // serverRowFor includes updated_at, so the 4th arg (cloudUpdatedAt) mirrors it too.
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'remote-note-1',
      expect.any(String),
      expect.any(String),
    );
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 62 }),
      'remote-note-62',
      expect.any(String),
      expect.any(String),
    );
  });

  it('a 400 on the first chunk marks only that chunk terminal; the next chunk still runs and succeeds', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue(manyCreates(60));
    mockBatchCreateNotes
      .mockRejectedValueOnce(new ApiError('Payload rejected', 400))
      .mockImplementationOnce(async (items: { client_note_id: string }[]) =>
        items.map((i) => serverRowFor(Number(i.client_note_id.split('-')[2]))),
      );

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).toHaveBeenCalledTimes(2);

    // Chunk 1 (localIds 1-50): terminal, pendingSync cleared, nothing marked pushed.
    expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledTimes(50);
    for (let id = 1; id <= 50; id += 1) {
      expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledWith(id);
    }
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'warning' }),
    );

    // Chunk 2 (localIds 51-60): unaffected by chunk 1's failure, pushed normally.
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(10);
    for (let id = 51; id <= 60; id += 1) {
      expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
        expect.objectContaining({ id: id }),
        `remote-note-${id}`,
        expect.any(String),
        expect.any(String),
      );
    }

    // The 400'd chunk must not count toward the retryable-failure total.
    expect(mockCaptureException).not.toHaveBeenCalledWith(
      expect.any(ApiError),
      expect.objectContaining({ tags: { sync: 'pushNotes.create' } }),
    );
  });
});

describe('pushNotes POLICY_CLOUD_BACKUP_BLOCKED propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
  });

  it('rethrows a create 403+POLICY_CLOUD_BACKUP_BLOCKED as-is (not wrapped in "operation(s) failed"), marks nothing terminal or pushed', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, clientNoteId: 'client-note-1', folderId: null }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(
      new ApiError('Cloud backup is off for your org', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );

    await expect(pushNotes()).rejects.toMatchObject({
      status: 403,
      code: 'POLICY_CLOUD_BACKUP_BLOCKED',
    });

    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    // Not routed through the generic retry-count/Sentry path — the caller
    // (syncEngine) handles this distinctly.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows an update 403+POLICY_CLOUD_BACKUP_BLOCKED, leaving the row untouched (pendingSync preserved)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(
      new ApiError('Cloud backup is off for your org', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );

    await expect(pushNotes()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a create chunk tripping the block stops before any update/delete in the same run', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, clientNoteId: 'client-note-1', folderId: null }),
      note({ id: 2, remoteId: 'remote-note-2', folderId: null }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(
      new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );

    await expect(pushNotes()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockUpdateNoteRemote).not.toHaveBeenCalled();
  });
});

const space = (over: Partial<Space>): Space =>
  ({
    id: 1,
    clientSpaceId: 'client-space-1',
    cloudSpaceId: null,
    workspaceId: null,
    kind: 'private',
    name: 'Personal',
    emoji: null,
    sortOrder: 0,
    myRole: null,
    memberCount: 0,
    teams: null,
    syncStatus: 'synced',
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as Space;

const PRIVATE_SPACE = space({ id: 1, kind: 'private' });
const TEAM_SPACE = space({
  id: 2,
  kind: 'team',
  name: 'Design',
  cloudSpaceId: 'cloud-space-2',
  workspaceId: 'workspace-9',
});
const TEAM_SPACE_SKELETON = space({ id: 3, kind: 'team', name: 'Pending', cloudSpaceId: null });
const TEAM_SPACE_B = space({
  id: 4,
  kind: 'team',
  name: 'Marketing',
  cloudSpaceId: 'cloud-space-4',
  workspaceId: 'workspace-9',
});

describe('pushNotes scope fields (Task 8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockImplementation((key) =>
      key === 'team_spaces_capability' ? 'true' : null,
    );
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE, TEAM_SPACE_SKELETON]);
    mockBatchCreateNotes.mockResolvedValue([
      {
        id: 'remote-note-1',
        client_note_id: 'client-note-1',
        updated_at: '2026-08-24T12:00:00.000Z',
      },
    ]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-1',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
  });

  it('sends the team space identity on create and on a base-guarded update', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, folderId: null, spaceId: TEAM_SPACE.id }),
      note({
        id: 2,
        remoteId: 'remote-note-2',
        folderId: null,
        spaceId: TEAM_SPACE.id,
        cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await pushNotes();

    expect(mockBatchCreateNotes).toHaveBeenCalledWith([
      expect.objectContaining({ workspace_id: 'workspace-9', space_id: 'cloud-space-2' }),
    ]);
    expect(mockUpdateNoteRemote).toHaveBeenCalledWith(
      'remote-note-2',
      expect.objectContaining({
        workspace_id: 'workspace-9',
        space_id: 'cloud-space-2',
        base_updated_at: '2026-08-24T09:00:00.000Z',
      }),
    );
  });

  it('omits scope on an update with no base_updated_at, so an unguarded claim cannot reverse a move', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        spaceId: TEAM_SPACE.id,
        cloudUpdatedAt: null,
      }),
    ]);

    await pushNotes();

    const payload = mockUpdateNoteRemote.mock.calls[0][1];
    expect('space_id' in payload).toBe(false);
    expect('workspace_id' in payload).toBe(false);
    expect('base_updated_at' in payload).toBe(false);
  });

  it('sends explicit nulls for a private-space note so a move back to personal propagates', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        spaceId: PRIVATE_SPACE.id,
        cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await pushNotes();

    expect(mockUpdateNoteRemote).toHaveBeenCalledWith(
      'remote-note-1',
      expect.objectContaining({ workspace_id: null, space_id: null }),
    );
  });

  it('omits both keys entirely when the backend has no team-spaces capability', async () => {
    mockNotesRepository.getSyncState.mockImplementation((key) =>
      key === 'team_spaces_capability' ? 'false' : null,
    );
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        spaceId: TEAM_SPACE.id,
        cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await pushNotes();

    const payload = mockUpdateNoteRemote.mock.calls[0][1];
    expect('space_id' in payload).toBe(false);
    expect('workspace_id' in payload).toBe(false);
  });

  it('skips a row whose space no longer resolves, leaving it pending', async () => {
    // syncSpaces soft-deletes a revoked space earlier in the same run, so its
    // rows point at a space listSpaces no longer returns.
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, folderId: null, spaceId: 999 }),
      note({ id: 2, remoteId: 'remote-note-2', folderId: null, spaceId: 999 }),
    ]);

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).not.toHaveBeenCalled();
    expect(mockUpdateNoteRemote).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'info' }),
    );
  });

  it('skips a row whose team space has no cloud id yet, leaving it pending and erroring nothing', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: null, folderId: null, spaceId: TEAM_SPACE_SKELETON.id }),
      note({ id: 2, remoteId: 'remote-note-2', folderId: null, spaceId: TEAM_SPACE_SKELETON.id }),
    ]);

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).not.toHaveBeenCalled();
    expect(mockUpdateNoteRemote).not.toHaveBeenCalled();
    // Nothing settles the rows: pendingSync stays set for the next pass.
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNotePushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'info' }),
    );
  });

  it('still deletes a note whose team space has no cloud id (DELETE carries no scope)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        folderId: null,
        spaceId: TEAM_SPACE_SKELETON.id,
        deletedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.hardDeleteNote).toHaveBeenCalledWith(1);
  });
});

describe('pushNotes code-aware error recovery (Task 8)', () => {
  const SPACE_ACCESS_CODES = [
    'team_not_found',
    'team_access_revoked',
    'team_archived',
    'space_not_found',
    'space_access_revoked',
    'space_archived',
  ];
  // Statuses the API pairs each code with; the code must win over every one of
  // them (a bare 404 on update, for instance, means something else entirely).
  const STATUS_FOR_CODE: Record<string, number> = {
    team_not_found: 404,
    team_access_revoked: 403,
    team_archived: 410,
    space_not_found: 404,
    space_access_revoked: 403,
    space_archived: 410,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockImplementation((key) =>
      key === 'team_spaces_capability' ? 'true' : null,
    );
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE]);
  });

  it.each(SPACE_ACCESS_CODES)(
    '%s on update forks the dirty note to personal and does not count as a failure',
    async (code) => {
      mockNotesRepository.getPendingNotes.mockReturnValue([
        note({ id: 1, remoteId: 'remote-note-1', folderId: null, spaceId: TEAM_SPACE.id }),
      ]);
      mockUpdateNoteRemote.mockRejectedValue(
        new ApiError('Space gone', STATUS_FOR_CODE[code], code),
      );

      await expect(pushNotes()).resolves.toBeUndefined();

      expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(1);
      expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
      // The 404-coded members must not fall through to T2's resetRemoteId rule.
      expect(mockNotesRepository.clearNoteRemoteId).not.toHaveBeenCalled();
      expect(mockNotesRepository.dropNotePushAttempt).not.toHaveBeenCalled();
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'sync', level: 'warning' }),
      );
      expect(mockCaptureException).not.toHaveBeenCalled();
    },
  );

  it.each(SPACE_ACCESS_CODES)('%s on create forks every dirty row in the chunk', async (code) => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        clientNoteId: 'client-note-1',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
      note({
        id: 2,
        remoteId: null,
        clientNoteId: 'client-note-2',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(new ApiError('Space gone', STATUS_FOR_CODE[code], code));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a space-access rejection on one create chunk leaves the later chunks running', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue(
      Array.from({ length: 55 }, (_, idx) =>
        note({
          id: idx + 1,
          remoteId: null,
          clientNoteId: `client-note-${idx + 1}`,
          folderId: null,
          spaceId: TEAM_SPACE.id,
        }),
      ),
    );
    mockBatchCreateNotes
      .mockRejectedValueOnce(new ApiError('Space gone', 403, 'space_access_revoked'))
      .mockImplementationOnce(async (items: { client_note_id: string }[]) =>
        items.map((i) => ({
          id: `remote-${i.client_note_id}`,
          client_note_id: i.client_note_id,
          updated_at: '2026-08-24T12:00:00.000Z',
        })),
      );

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).toHaveBeenCalledTimes(2);
    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledTimes(50);
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(5);
  });

  it('clears pendingSync instead of forking when the rejected row has nothing left to push', async () => {
    // Defensive branch: the push queue only ever holds dirty rows today.
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        pendingSync: 0,
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Space gone', 410, 'space_archived'));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.markNoteTerminal).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
  });

  it('forks a row whose only unpushed work is an edited transcript', async () => {
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(true);
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        pendingSync: 0,
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Space gone', 403, 'team_access_revoked'));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
  });

  it.each(['note_access_denied', 'note_scope_change_denied'])(
    '%s on update drops the local attempt and resets the team cursors',
    async (code) => {
      mockNotesRepository.getPendingNotes.mockReturnValue([
        note({ id: 1, remoteId: 'remote-note-1', folderId: null, spaceId: TEAM_SPACE.id }),
      ]);
      mockUpdateNoteRemote.mockRejectedValue(new ApiError('Not allowed', 403, code));

      await expect(pushNotes()).resolves.toBeUndefined();

      expect(mockNotesRepository.dropNotePushAttempt).toHaveBeenCalledWith(1);
      expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
      expect(mockNotesRepository.clearSyncState).toHaveBeenCalledWith('notes.team.last_sync_at');
      expect(mockNotesRepository.clearSyncState).toHaveBeenCalledWith('notes.team.last_sync_id');
      expect(mockNotesRepository.clearSyncState).toHaveBeenCalledWith('folders.team.last_sync_at');
      expect(mockCaptureException).not.toHaveBeenCalled();
    },
  );

  it('note_access_denied on create drops every row in the chunk and resets the cursors once', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        clientNoteId: 'client-note-1',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
      note({
        id: 2,
        remoteId: null,
        clientNoteId: 'client-note-2',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockBatchCreateNotes.mockRejectedValue(new ApiError('Not allowed', 403, 'note_access_denied'));

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.dropNotePushAttempt).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.dropNotePushAttempt).toHaveBeenCalledWith(2);
    expect(mockNotesRepository.clearSyncState).toHaveBeenCalledTimes(3);
  });

  it('leaves an uncoded 403 on the retry path (no scope recovery on a bare status)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null, spaceId: TEAM_SPACE.id }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(new ApiError('Forbidden', 403));

    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
    expect(mockNotesRepository.dropNotePushAttempt).not.toHaveBeenCalled();
    expect(mockNotesRepository.clearSyncState).not.toHaveBeenCalled();
  });

  it('still parks a 409 note_version_conflict (Task 5 path is untouched by the code checks)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: 'remote-note-1',
        folderId: null,
        spaceId: TEAM_SPACE.id,
        cloudUpdatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(
      new ApiError('Edited elsewhere', 409, 'note_version_conflict', {
        note: { id: 'remote-note-1', updated_at: '2026-08-24T12:00:00.000Z' },
      }),
    );

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockNotesRepository.parkNoteConflict).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
    expect(mockNotesRepository.dropNotePushAttempt).not.toHaveBeenCalled();
  });

  it('still rethrows POLICY_CLOUD_BACKUP_BLOCKED ahead of any code-aware recovery', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 1, remoteId: 'remote-note-1', folderId: null, spaceId: TEAM_SPACE.id }),
    ]);
    mockUpdateNoteRemote.mockRejectedValue(
      new ApiError('blocked', 403, 'POLICY_CLOUD_BACKUP_BLOCKED'),
    );

    await expect(pushNotes()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
    expect(mockNotesRepository.dropNotePushAttempt).not.toHaveBeenCalled();
  });
});

describe('pushNotes scope-grouped create batching (Task 8 fix round)', () => {
  // batch-create is all-or-nothing with no per-row detail, so a chunk must
  // never mix scopes: a rejection from one revoked space would otherwise
  // settle rows belonging to a healthy space (silent scope loss) and
  // re-identify personal rows that were never in a space.
  type CreateItem = { client_note_id: string; space_id?: string | null };

  const createdFor = async (items: CreateItem[]) =>
    items.map((i) => ({
      id: `remote-${i.client_note_id}`,
      client_note_id: i.client_note_id,
      updated_at: '2026-08-24T12:00:00.000Z',
    }));

  const spaceIdsIn = (call: CreateItem[]): (string | null | undefined)[] => [
    ...new Set(call.map((i) => i.space_id)),
  ];

  const pendingCreate = (id: number, spaceId: number): Note =>
    note({ id, remoteId: null, clientNoteId: `client-note-${id}`, folderId: null, spaceId });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.getPendingNotes.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockImplementation((key) =>
      key === 'team_spaces_capability' ? 'true' : null,
    );
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE, TEAM_SPACE_B]);
    mockBatchCreateNotes.mockImplementation(createdFor);
  });

  it('splits pending creates across personal and two team spaces into one request per scope', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
      pendingCreate(3, PRIVATE_SPACE.id),
      pendingCreate(4, TEAM_SPACE_B.id),
      pendingCreate(5, TEAM_SPACE.id),
    ]);

    await expect(pushNotes()).resolves.toBeUndefined();

    expect(mockBatchCreateNotes).toHaveBeenCalledTimes(3);
    const calls = mockBatchCreateNotes.mock.calls.map((c) => c[0] as CreateItem[]);
    // Every request carries exactly one scope...
    for (const call of calls) expect(spaceIdsIn(call)).toHaveLength(1);
    // ...and between them they cover all three, with no row left behind.
    expect(new Set(calls.map((call) => spaceIdsIn(call)[0]))).toEqual(
      new Set([null, 'cloud-space-2', 'cloud-space-4']),
    );
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(5);
  });

  it('still respects PUSH_BATCH_SIZE inside a single scope bucket', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      ...Array.from({ length: 51 }, (_, idx) => pendingCreate(idx + 1, TEAM_SPACE.id)),
      pendingCreate(52, PRIVATE_SPACE.id),
    ]);

    await expect(pushNotes()).resolves.toBeUndefined();

    const calls = mockBatchCreateNotes.mock.calls.map((c) => c[0] as CreateItem[]);
    expect(calls.map((call) => call.length)).toEqual([50, 1, 1]);
    expect(calls.map((call) => spaceIdsIn(call)[0])).toEqual([
      'cloud-space-2',
      'cloud-space-2',
      null,
    ]);
  });

  it('forks only the revoked space’s rows; the other team space and personal rows still push', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
      pendingCreate(3, TEAM_SPACE_B.id),
      pendingCreate(4, TEAM_SPACE.id),
    ]);
    mockBatchCreateNotes.mockImplementation(async (items: CreateItem[]) => {
      if (items[0].space_id === TEAM_SPACE.cloudSpaceId) {
        throw new ApiError('Space access revoked', 403, 'space_access_revoked');
      }
      return createdFor(items);
    });

    await expect(pushNotes()).resolves.toBeUndefined();

    // Only space A's rows are re-homed.
    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledTimes(2);
    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(2);
    expect(mockNotesRepository.forkNoteToPrivate).toHaveBeenCalledWith(4);
    // Space B's row and the personal row are untouched by A's failure.
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(2);
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'remote-client-note-1',
      expect.any(String),
      expect.any(String),
    );
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      'remote-client-note-3',
      expect.any(String),
      expect.any(String),
    );
  });

  it('treats a space-access code on a personal-scope chunk as retryable and never forks', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
    ]);
    mockBatchCreateNotes.mockImplementation(async (items: CreateItem[]) => {
      if (items[0].space_id == null) {
        throw new ApiError('Space gone', 404, 'space_not_found');
      }
      return createdFor(items);
    });

    // Retryable → the pass reports the failure instead of settling the row.
    await expect(pushNotes()).rejects.toThrow('pushNotes: 1 operation(s) failed');

    expect(mockNotesRepository.forkNoteToPrivate).not.toHaveBeenCalled();
    expect(mockNotesRepository.markNoteTerminal).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'sync',
        level: 'warning',
        message: expect.stringContaining('personal-scope create chunk'),
      }),
    );
    // The team chunk in the same pass is unaffected.
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'remote-client-note-2',
      expect.any(String),
      expect.any(String),
    );
  });
});

describe('pushNotes teamOnly filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockImplementation((key) =>
      key === 'team_spaces_capability' ? 'true' : null,
    );
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE]);
    mockBatchCreateNotes.mockResolvedValue([
      {
        id: 'remote-note-2',
        client_note_id: 'client-note-2',
        updated_at: '2026-08-24T12:00:00.000Z',
      },
    ]);
    mockUpdateNoteRemote.mockResolvedValue({
      id: 'remote-note-3',
      updated_at: '2026-08-24T12:00:00.000Z',
    });
  });

  it('default (no argument) pushes every pending row, private and team alike — unchanged behavior', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        clientNoteId: 'client-note-1',
        folderId: null,
        spaceId: PRIVATE_SPACE.id,
      }),
      note({
        id: 2,
        remoteId: null,
        clientNoteId: 'client-note-2',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockBatchCreateNotes.mockImplementation(async (items: { client_note_id: string }[]) =>
      items.map((i) => ({
        id: `remote-${i.client_note_id}`,
        client_note_id: i.client_note_id,
        updated_at: '2026-08-24T12:00:00.000Z',
      })),
    );

    await pushNotes();

    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(2);
  });

  it('teamOnly=true pushes only the team-space row, leaving the private one pending', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        clientNoteId: 'client-note-1',
        folderId: null,
        spaceId: PRIVATE_SPACE.id,
      }),
      note({
        id: 2,
        remoteId: null,
        clientNoteId: 'client-note-2',
        folderId: null,
        spaceId: TEAM_SPACE.id,
      }),
    ]);

    await pushNotes(true);

    expect(mockBatchCreateNotes).toHaveBeenCalledTimes(1);
    expect(mockBatchCreateNotes).toHaveBeenCalledWith([
      expect.objectContaining({ client_note_id: 'client-note-2' }),
    ]);
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.markNotePushed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'remote-note-2',
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:00:00.000Z',
    );
  });

  it('teamOnly=true still pushes a team-space update, but never a private-space one', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ id: 2, remoteId: 'remote-note-2', folderId: null, spaceId: TEAM_SPACE.id }),
      note({ id: 3, remoteId: 'remote-note-3', folderId: null, spaceId: PRIVATE_SPACE.id }),
    ]);

    await pushNotes(true);

    expect(mockUpdateNoteRemote).toHaveBeenCalledTimes(1);
    expect(mockUpdateNoteRemote).toHaveBeenCalledWith('remote-note-2', expect.anything());
  });

  // Fix round 1, Finding 2: a pending delete carries no scope (DELETE has no
  // body) and full-mode pushNotes() never filters deletes by space either, so
  // a delete must flow the same way under teamOnly, regardless of which space
  // the row sits in.
  it('teamOnly=true still pushes a private-space delete — deletes are exempt from the filter', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 3,
        remoteId: 'remote-note-3',
        deletedAt: '2026-08-24T12:00:00.000Z',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockDeleteNote.mockResolvedValue(undefined);

    await pushNotes(true);

    expect(mockDeleteNote).toHaveBeenCalledWith('remote-note-3');
    expect(mockNotesRepository.hardDeleteNote).toHaveBeenCalledWith(3);
  });

  it('teamOnly=true still pushes a delete for a row whose space is no longer in listSpaces (revoked this run)', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 3,
        remoteId: 'remote-note-3',
        deletedAt: '2026-08-24T12:00:00.000Z',
        spaceId: 999,
      }),
    ]);
    mockDeleteNote.mockResolvedValue(undefined);

    await pushNotes(true);

    expect(mockDeleteNote).toHaveBeenCalledWith('remote-note-3');
    expect(mockNotesRepository.hardDeleteNote).toHaveBeenCalledWith(3);
  });

  it('teamOnly=true still hard-deletes a never-pushed row (remoteId null) regardless of space', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 3,
        remoteId: null,
        deletedAt: '2026-08-24T12:00:00.000Z',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);

    await pushNotes(true);

    expect(mockDeleteNote).not.toHaveBeenCalled();
    expect(mockNotesRepository.hardDeleteNote).toHaveBeenCalledWith(3);
  });

  it('teamOnly=true is a no-op (no network calls) when nothing pending is team-scoped', async () => {
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({
        id: 1,
        remoteId: null,
        clientNoteId: 'client-note-1',
        folderId: null,
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);

    await pushNotes(true);

    expect(mockBatchCreateNotes).not.toHaveBeenCalled();
    expect(mockUpdateNoteRemote).not.toHaveBeenCalled();
  });
});

describe('pushNotes create timestamps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getFolders.mockReturnValue([]);
    mockNotesRepository.hasDirtyTranscript.mockReturnValue(false);
    mockNotesRepository.getSegments.mockReturnValue([]);
    mockNotesRepository.getSpeakers.mockReturnValue([]);
    mockListSpaces.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockReturnValue(null);
    mockBatchCreateNotes.mockResolvedValue([
      { id: 'remote-note-1', client_note_id: 'client-note-1' },
    ]);
  });

  it('lets the server stamp updated_at on create so other devices never crawl past the row', async () => {
    // The row's last local edit can be hours old by the time it uploads
    // (offline, unsubscribed, or re-created by an account link). Desktop's
    // delta cursor is wall-clock, so a create carrying that stale timestamp
    // lands behind the cursor and is never pulled.
    mockNotesRepository.getPendingNotes.mockReturnValue([
      note({ folderId: null, updatedAt: '2026-06-26T10:00:00.000Z' }),
    ]);

    await pushNotes();

    const [payload] = mockBatchCreateNotes.mock.calls[0][0] as Record<string, unknown>[];
    expect('updated_at' in payload).toBe(false);
    expect(payload.created_at).toBe('2026-06-26T09:00:00.000Z');
  });
});
