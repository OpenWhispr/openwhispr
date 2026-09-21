jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    getFoldersIncludingDeleted: jest.fn(),
    getNoteForRemote: jest.fn(),
    isRemoteNoteHeldByFolderDelete: jest.fn(() => false),
    hasDirtyTranscript: jest.fn(),
    applyRemoteNote: jest.fn(),
    forkNoteToPrivate: jest.fn(),
    hardDeleteNote: jest.fn(),
  },
  spacesRepository: {
    getPrivateSpace: jest.fn(),
    getByCloudId: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  fetchNotes: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import { pullNotesTeam } from '../pullNotesTeam';
import { notesRepository, spacesRepository } from '@/data';
import { fetchNotes } from '@/data/remote/notesApi';
import type { Note, RemoteNote } from '@/data';
import type { Space } from '@/data/spacesTypes';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;
const mockSpaces = spacesRepository as jest.Mocked<typeof spacesRepository>;
const mockFetchNotes = fetchNotes as jest.MockedFunction<typeof fetchNotes>;

const CURSOR_KEYS = ['notes.team.last_sync_at', 'notes.team.last_sync_id'];
/** Cursor writes only — filters out the park-streak bookkeeping key. */
const cursorWrites = (): [string, string][] =>
  mockRepo.setSyncState.mock.calls.filter(([key]) => CURSOR_KEYS.includes(key));

const PRIVATE_SPACE_ID = 1;
const TEAM_SPACE_ID = 7;

const remoteId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function makeNote(index: number, overrides: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: remoteId(index),
    client_note_id: `client-${index}`,
    title: `Note ${index}`,
    content: 'body',
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
    updated_at: `2026-07-0${index + 1}T00:00:00.000Z`,
    ...overrides,
  };
}

function makeLocalNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 42,
    pendingSync: 0,
    isPrivate: 0,
    deletedAt: null,
    ...overrides,
  } as Note;
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return { id: PRIVATE_SPACE_ID, kind: 'private', name: 'Personal', ...overrides } as Space;
}

/** Backs getSyncState with a plain map so cursor writes can be asserted per key. */
function withCursors(values: Record<string, string>): void {
  mockRepo.getSyncState.mockImplementation((key: string) => values[key] ?? null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.getFoldersIncludingDeleted.mockReturnValue([]);
  mockRepo.getNoteForRemote.mockReturnValue(null);
  mockRepo.hasDirtyTranscript.mockReturnValue(false);
  mockSpaces.getPrivateSpace.mockReturnValue(makeSpace());
  mockSpaces.getByCloudId.mockReturnValue(makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }));
  withCursors({});
});

describe('pullNotesTeam — scope and cursors', () => {
  it('requests scope=all from its own cursor pair, never the personal cursors', async () => {
    withCursors({
      'notes.last_sync_at': '2026-01-01T00:00:00.000Z',
      'notes.team.last_sync_at': '2026-07-01T00:00:00.000Z',
      'notes.team.last_sync_id': remoteId(9),
    });
    mockFetchNotes.mockResolvedValue({ notes: [] });

    await pullNotesTeam();

    expect(mockFetchNotes).toHaveBeenCalledWith({
      since: '2026-07-01T00:00:00.000Z',
      sinceId: remoteId(9),
      limit: 200,
      scope: 'all',
    });
    // An empty page leaves both team cursors exactly where they were, and
    // never touches the personal ones.
    expect(mockRepo.setSyncState).not.toHaveBeenCalled();
  });

  it('crawls from the epoch on the first run, like the personal pass', async () => {
    mockFetchNotes.mockResolvedValue({ notes: [] });

    await pullNotesTeam();

    expect(mockFetchNotes).toHaveBeenCalledWith({
      since: '1970-01-01T00:00:00.000Z',
      sinceId: undefined,
      limit: 200,
      scope: 'all',
    });
  });

  it('advances the team cursor pair to the last processed row', async () => {
    const rows = [
      makeNote(0, { space_id: 'cloud-space-1' }),
      makeNote(1, { space_id: 'cloud-space-1' }),
    ];
    mockFetchNotes.mockResolvedValue({ notes: rows });

    await pullNotesTeam();

    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'notes.team.last_sync_at',
      rows[1].updated_at,
    );
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.last_sync_id', rows[1].id);
  });

  it('pages through full pages using the composite cursor', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      makeNote(i, { updated_at: '2026-07-02T00:00:00.000Z', space_id: 'cloud-space-1' }),
    );
    const lastPage = [
      makeNote(200, { updated_at: '2026-07-03T00:00:00.000Z', space_id: 'cloud-space-1' }),
    ];
    mockFetchNotes
      .mockResolvedValueOnce({ notes: fullPage })
      .mockResolvedValueOnce({ notes: lastPage });

    await pullNotesTeam();

    expect(mockFetchNotes).toHaveBeenCalledTimes(2);
    expect(mockFetchNotes).toHaveBeenNthCalledWith(2, {
      since: '2026-07-02T00:00:00.000Z',
      sinceId: fullPage[199].id,
      limit: 200,
      scope: 'all',
    });
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(201);
  });

  it('an explicit hasMore=false on a full page stops without an extra request', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      makeNote(i, { space_id: 'cloud-space-1' }),
    );
    mockFetchNotes.mockResolvedValue({ notes: fullPage, hasMore: false });

    await pullNotesTeam();

    expect(mockFetchNotes).toHaveBeenCalledTimes(1);
  });
});

describe('pullNotesTeam — row selection', () => {
  it('processes only space / previous-space / stub rows and steps over personal ones', async () => {
    const personal = makeNote(0);
    const spaced = makeNote(1, { space_id: 'cloud-space-1' });
    const movedOut = makeNote(2, { space_id: null, previous_space_id: 'cloud-space-1' });
    const stub = makeNote(3, { access_removed: true, previous_space_id: 'cloud-space-1' });
    mockFetchNotes.mockResolvedValue({ notes: [personal, spaced, movedOut, stub] });

    await pullNotesTeam();

    // The personal row is the personal pass's business — never applied here.
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(2);
    expect(mockRepo.applyRemoteNote.mock.calls.map((call) => call[0].id)).toEqual([
      spaced.id,
      movedOut.id,
    ]);
    // Skipped rows still count as processed, so the cursor lands on the last row.
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.last_sync_id', stub.id);
  });

  it('applies a regular space row into the resolved local space with cloud ownership', async () => {
    const row = makeNote(0, {
      space_id: 'cloud-space-1',
      user_id: 'owner-1',
      updated_by_user_id: 'editor-2',
    });
    mockFetchNotes.mockResolvedValue({ notes: [row] });

    await pullNotesTeam();

    expect(mockSpaces.getByCloudId).toHaveBeenCalledWith('cloud-space-1');
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledWith(row, expect.any(Function), {
      spaceId: TEAM_SPACE_ID,
      applyOwnership: true,
    });
  });

  it('applies a team → personal transition into the private space', async () => {
    const row = makeNote(0, { space_id: null, previous_space_id: 'cloud-space-1' });
    mockFetchNotes.mockResolvedValue({ notes: [row] });

    await pullNotesTeam();

    expect(mockSpaces.getByCloudId).not.toHaveBeenCalled();
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledWith(row, expect.any(Function), {
      spaceId: PRIVATE_SPACE_ID,
      applyOwnership: true,
    });
  });

  it('sends a tombstone down the existing apply path with no scope options', async () => {
    const row = makeNote(0, {
      space_id: 'cloud-space-1',
      deleted_at: '2026-07-02T00:00:00.000Z',
    });
    mockFetchNotes.mockResolvedValue({ notes: [row] });

    await pullNotesTeam();

    expect(mockRepo.applyRemoteNote).toHaveBeenCalledWith(row, expect.any(Function));
    // A delete needs no space, so an unresolvable one must not park the crawl.
    expect(mockSpaces.getByCloudId).not.toHaveBeenCalled();
  });

  it('resolves the note folder through the local folder map', async () => {
    mockRepo.getFoldersIncludingDeleted.mockReturnValue([
      { id: 5, remoteId: 'srv-folder-1' } as never,
    ]);
    const row = makeNote(0, { space_id: 'cloud-space-1', folder_id: 'srv-folder-1' });
    mockFetchNotes.mockResolvedValue({ notes: [row] });

    await pullNotesTeam();

    const resolveFolder = mockRepo.applyRemoteNote.mock.calls[0][1];
    expect(resolveFolder('srv-folder-1')).toBe(5);
    expect(resolveFolder(null)).toBeNull();
  });

  it('resolves into a locally soft-deleted folder rather than parking on it forever', async () => {
    // getFolders() hides soft-deleted rows; resolving against it would park
    // every note filed in a folder whose delete hasn't pushed yet — and nothing
    // about that state ever resolves itself, so the crawl would wedge.
    mockRepo.getFoldersIncludingDeleted.mockReturnValue([
      { id: 5, remoteId: 'srv-folder-1', deletedAt: '2026-07-02T00:00:00.000Z' } as never,
    ]);
    const row = makeNote(0, { space_id: 'cloud-space-1', folder_id: 'srv-folder-1' });
    mockFetchNotes.mockResolvedValue({ notes: [row] });

    await pullNotesTeam();

    expect(mockRepo.applyRemoteNote).toHaveBeenCalledWith(row, expect.any(Function), {
      spaceId: TEAM_SPACE_ID,
      applyOwnership: true,
    });
    expect(mockRepo.applyRemoteNote.mock.calls[0][1]('srv-folder-1')).toBe(5);
    expect(cursorWrites()).toContainEqual(['notes.team.last_sync_id', row.id]);
  });
});

describe('pullNotesTeam — access-removed stubs', () => {
  const stub = makeNote(0, { access_removed: true, previous_space_id: 'cloud-space-1' });

  it('hard-deletes a clean local copy', async () => {
    mockRepo.getNoteForRemote.mockReturnValue(makeLocalNote({ id: 42, pendingSync: 0 }));
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.hardDeleteNote).toHaveBeenCalledWith(42);
    expect(mockRepo.forkNoteToPrivate).not.toHaveBeenCalled();
    // Stubs carry no content — nothing may be applied from them.
    expect(mockRepo.applyRemoteNote).not.toHaveBeenCalled();
  });

  it('forks a dirty local copy to the private space instead of deleting it', async () => {
    mockRepo.getNoteForRemote.mockReturnValue(makeLocalNote({ id: 42, pendingSync: 1 }));
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.forkNoteToPrivate).toHaveBeenCalledWith(42);
    expect(mockRepo.hardDeleteNote).not.toHaveBeenCalled();
  });

  it('forks a note whose only unpushed work is an edited transcript', async () => {
    // getPendingNotes counts dirty segments/speakers as unpushed work, so this
    // note is queued for push despite pendingSync=0. Hard-deleting it would
    // destroy the transcript edits (and unlink the audio) with no recovery.
    mockRepo.getNoteForRemote.mockReturnValue(makeLocalNote({ id: 42, pendingSync: 0 }));
    mockRepo.hasDirtyTranscript.mockReturnValue(true);
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.hasDirtyTranscript).toHaveBeenCalledWith(42);
    expect(mockRepo.forkNoteToPrivate).toHaveBeenCalledWith(42);
    expect(mockRepo.hardDeleteNote).not.toHaveBeenCalled();
  });

  it('hard-deletes rather than forks a dirty row the user already deleted locally', async () => {
    mockRepo.getNoteForRemote.mockReturnValue(
      makeLocalNote({ id: 42, pendingSync: 1, deletedAt: '2026-07-02T00:00:00.000Z' }),
    );
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.hardDeleteNote).toHaveBeenCalledWith(42);
    expect(mockRepo.forkNoteToPrivate).not.toHaveBeenCalled();
  });

  it('leaves a locally-private row alone — the server has no authority over it', async () => {
    mockRepo.getNoteForRemote.mockReturnValue(makeLocalNote({ id: 42, isPrivate: 1 }));
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.hardDeleteNote).not.toHaveBeenCalled();
    expect(mockRepo.forkNoteToPrivate).not.toHaveBeenCalled();
  });

  it('ignores a stub with no local copy but still advances the cursor past it', async () => {
    mockRepo.getNoteForRemote.mockReturnValue(null);
    mockFetchNotes.mockResolvedValue({ notes: [stub] });

    await pullNotesTeam();

    expect(mockRepo.hardDeleteNote).not.toHaveBeenCalled();
    expect(mockRepo.forkNoteToPrivate).not.toHaveBeenCalled();
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.last_sync_id', stub.id);
  });
});

describe('pullNotesTeam — parking', () => {
  it('parks on an unknown space, holding the cursor at the last applied row', async () => {
    const applied = makeNote(0, { space_id: 'cloud-space-1' });
    const parkedRow = makeNote(1, { space_id: 'cloud-space-unknown' });
    const later = makeNote(2, { space_id: 'cloud-space-1' });
    mockSpaces.getByCloudId.mockImplementation((cloudId: string) =>
      cloudId === 'cloud-space-1' ? makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }) : null,
    );
    mockFetchNotes.mockResolvedValue({ notes: [applied, parkedRow, later] });

    await expect(pullNotesTeam()).resolves.toBeUndefined();

    // Only the row before the parked one was applied; the crawl stopped there.
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(1);
    expect(mockRepo.applyRemoteNote.mock.calls[0][0].id).toBe(applied.id);
    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'notes.team.last_sync_at',
      applied.updated_at,
    );
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.last_sync_id', applied.id);
  });

  it('parks on a note whose folder is not local yet', async () => {
    const applied = makeNote(0, { space_id: 'cloud-space-1' });
    const parkedRow = makeNote(1, { space_id: 'cloud-space-1', folder_id: 'srv-folder-missing' });
    mockFetchNotes.mockResolvedValue({ notes: [applied, parkedRow] });

    await expect(pullNotesTeam()).resolves.toBeUndefined();

    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(1);
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.last_sync_id', applied.id);
  });

  it('leaves the cursor completely untouched when the very first row parks', async () => {
    mockSpaces.getByCloudId.mockReturnValue(null);
    mockFetchNotes.mockResolvedValue({ notes: [makeNote(0, { space_id: 'cloud-space-unknown' })] });

    await pullNotesTeam();

    expect(cursorWrites()).toEqual([]);
  });

  it('stops the crawl at the parked page — no further pages are requested', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      makeNote(i, { space_id: i === 5 ? 'cloud-space-unknown' : 'cloud-space-1' }),
    );
    mockSpaces.getByCloudId.mockImplementation((cloudId: string) =>
      cloudId === 'cloud-space-1' ? makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }) : null,
    );
    mockFetchNotes.mockResolvedValue({ notes: fullPage });

    await pullNotesTeam();

    expect(mockFetchNotes).toHaveBeenCalledTimes(1);
    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(5);
  });

  it('still drains access-removed stubs sitting behind the parked row', async () => {
    // Revocation must not wait on an unrelated park: the content is no longer
    // ours to hold, and a stub can neither park nor be harmed by replaying.
    const parkedRow = makeNote(0, { space_id: 'cloud-space-unknown' });
    const stub = makeNote(1, { access_removed: true, previous_space_id: 'cloud-space-1' });
    mockSpaces.getByCloudId.mockReturnValue(null);
    mockRepo.getNoteForRemote.mockReturnValue(makeLocalNote({ id: 42, pendingSync: 0 }));
    mockFetchNotes.mockResolvedValue({ notes: [parkedRow, stub] });

    await pullNotesTeam();

    expect(mockRepo.hardDeleteNote).toHaveBeenCalledWith(42);
    // The cursor is still held before the parked row, so the next run replays
    // both — the stub included, harmlessly.
    expect(cursorWrites()).toEqual([]);
  });

  it('applies nothing else behind the park, and does not advance past skipped rows', async () => {
    const applied = makeNote(0, { space_id: 'cloud-space-1' });
    const parkedRow = makeNote(1, { space_id: 'cloud-space-unknown' });
    const behindPersonal = makeNote(2);
    const behindTeam = makeNote(3, { space_id: 'cloud-space-1' });
    mockSpaces.getByCloudId.mockImplementation((cloudId: string) =>
      cloudId === 'cloud-space-1' ? makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }) : null,
    );
    mockFetchNotes.mockResolvedValue({
      notes: [applied, parkedRow, behindPersonal, behindTeam],
    });

    await pullNotesTeam();

    expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(1);
    expect(mockRepo.applyRemoteNote.mock.calls[0][0].id).toBe(applied.id);
    // A personal row behind the park must not drag the cursor past the park.
    expect(cursorWrites()).toEqual([
      ['notes.team.last_sync_at', applied.updated_at],
      ['notes.team.last_sync_id', applied.id],
    ]);
  });
});

describe('pullNotesTeam — park escalation', () => {
  const parkOnce = async (row: RemoteNote): Promise<void> => {
    mockSpaces.getByCloudId.mockReturnValue(null);
    mockFetchNotes.mockResolvedValue({ notes: [row] });
    await pullNotesTeam();
  };

  it('breadcrumbs the first parks and records the streak against the row id', async () => {
    const row = makeNote(0, { space_id: 'cloud-space-unknown' });

    await parkOnce(row);

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.parked_row', `${row.id}:1`);
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `team note pull parked at ${row.id}: unknown space cloud-space-unknown`,
      }),
    );
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('escalates to a warning once the same row parks three runs in a row', async () => {
    const row = makeNote(0, { space_id: 'cloud-space-unknown' });
    withCursors({ 'notes.team.parked_row': `${row.id}:2` });

    await parkOnce(row);

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.parked_row', `${row.id}:3`);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('parked 3 consecutive syncs'),
      'warning',
    );
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('restarts the streak when a different row parks', async () => {
    const row = makeNote(0, { space_id: 'cloud-space-unknown' });
    withCursors({ 'notes.team.parked_row': `some-other-row:5` });

    await parkOnce(row);

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.parked_row', `${row.id}:1`);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('clears the streak once the crawl gets past the row', async () => {
    withCursors({ 'notes.team.parked_row': `${remoteId(0)}:2` });
    mockFetchNotes.mockResolvedValue({ notes: [makeNote(0, { space_id: 'cloud-space-1' })] });

    await pullNotesTeam();

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('notes.team.parked_row', '');
  });

  it('does not write the streak key at all on a clean run with nothing parked', async () => {
    mockFetchNotes.mockResolvedValue({ notes: [makeNote(0, { space_id: 'cloud-space-1' })] });

    await pullNotesTeam();

    expect(mockRepo.setSyncState).not.toHaveBeenCalledWith('notes.team.parked_row', '');
  });
});
