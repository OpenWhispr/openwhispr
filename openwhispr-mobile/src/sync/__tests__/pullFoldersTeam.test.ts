jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    applyRemoteFolder: jest.fn(),
    getFolderByRemoteId: jest.fn(),
    hardDeleteFolder: jest.fn(),
  },
  spacesRepository: {
    getPrivateSpace: jest.fn(),
    getByCloudId: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  fetchFolders: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import { pullFoldersTeam } from '../pullFoldersTeam';
import { EPOCH } from '../pullNotes';
import { notesRepository, spacesRepository } from '@/data';
import { fetchFolders } from '@/data/remote/notesApi';
import type { Folder, RemoteFolder } from '@/data';
import type { Space } from '@/data/spacesTypes';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;
const mockSpaces = spacesRepository as jest.Mocked<typeof spacesRepository>;
const mockFetchFolders = fetchFolders as jest.MockedFunction<typeof fetchFolders>;

const PRIVATE_SPACE_ID = 1;
const TEAM_SPACE_ID = 7;

function makeFolder(index: number, overrides: Partial<RemoteFolder> = {}): RemoteFolder {
  return {
    id: `srv-folder-${index}`,
    client_folder_id: `client-folder-${index}`,
    name: `Folder ${index}`,
    is_default: false,
    sort_order: index,
    deleted_at: null,
    updated_at: `2026-07-0${index + 1}T00:00:00.000Z`,
    ...overrides,
  };
}

/**
 * The exact shape the server emits for a folder that left our reach (api repo
 * lib/folders-service.ts, toFolderAccessStub): ids, scope and updated_at only —
 * no name, is_default, sort_order or deleted_at, despite RemoteFolder declaring
 * them.
 */
function makeStub(index: number, overrides: Partial<RemoteFolder> = {}): RemoteFolder {
  return {
    id: `srv-folder-${index}`,
    client_folder_id: `client-folder-${index}`,
    workspace_id: 'cloud-workspace-1',
    space_id: 'cloud-space-1',
    previous_space_id: null,
    updated_at: `2026-07-0${index + 1}T00:00:00.000Z`,
    access_removed: true,
    ...overrides,
  } as RemoteFolder;
}

function makeLocalFolder(id: number): Folder {
  return { id, name: 'Team folder', remoteId: `srv-folder-${id}` } as Folder;
}

function makeSpace(overrides: Partial<Space> = {}): Space {
  return { id: PRIVATE_SPACE_ID, kind: 'private', name: 'Personal', ...overrides } as Space;
}

function withCursors(values: Record<string, string>): void {
  mockRepo.getSyncState.mockImplementation((key: string) => values[key] ?? null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpaces.getPrivateSpace.mockReturnValue(makeSpace());
  mockSpaces.getByCloudId.mockReturnValue(makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }));
  withCursors({});
});

describe('pullFoldersTeam', () => {
  it('requests scope=all from its own cursor, never the personal one', async () => {
    withCursors({
      'folders.last_sync_at': '2026-01-01T00:00:00.000Z',
      'folders.team.last_sync_at': '2026-07-01T00:00:00.000Z',
    });
    mockFetchFolders.mockResolvedValue([]);

    await pullFoldersTeam();

    expect(mockFetchFolders).toHaveBeenCalledWith('2026-07-01T00:00:00.000Z', 'all');
    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      '2026-07-01T00:00:00.000Z',
    );
    expect(mockRepo.setSyncState).toHaveBeenCalledTimes(1);
  });

  it('falls back to epoch when it has no cursor, so tombstones are not filtered out', async () => {
    // No cursor at all is what a fresh device — and a device that just ran
    // resetTeamCursors — looks like. Omitting `since` would put the endpoint in
    // its browse listing, which drops server-deleted folders entirely.
    withCursors({});
    mockFetchFolders.mockResolvedValue([]);

    await pullFoldersTeam();

    expect(mockFetchFolders).toHaveBeenCalledWith(EPOCH, 'all');
    expect(mockFetchFolders).not.toHaveBeenCalledWith(null, 'all');
  });

  it('processes only space / previous-space rows and steps over personal ones', async () => {
    const personal = makeFolder(0);
    const spaced = makeFolder(1, { space_id: 'cloud-space-1' });
    mockFetchFolders.mockResolvedValue([personal, spaced]);

    await pullFoldersTeam();

    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledTimes(1);
    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledWith(spaced, { spaceId: TEAM_SPACE_ID });
    // Skipped rows still advance the cursor.
    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      spaced.updated_at,
    );
  });

  it('applies a team → personal transition into the private space', async () => {
    const moved = makeFolder(0, { space_id: null, previous_space_id: 'cloud-space-1' });
    mockFetchFolders.mockResolvedValue([moved]);

    await pullFoldersTeam();

    expect(mockSpaces.getByCloudId).not.toHaveBeenCalled();
    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledWith(moved, { spaceId: PRIVATE_SPACE_ID });
  });

  it('sends a tombstone down the existing delete path with no scope options', async () => {
    const tombstone = makeFolder(0, {
      space_id: 'cloud-space-1',
      deleted_at: '2026-07-02T00:00:00.000Z',
    });
    mockFetchFolders.mockResolvedValue([tombstone]);

    await pullFoldersTeam();

    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledWith(tombstone);
    // A delete needs no space, so an unresolvable one must not park the pass.
    expect(mockSpaces.getByCloudId).not.toHaveBeenCalled();
  });

  it('parks on an unknown space: ends cleanly, applies nothing further, holds the cursor', async () => {
    withCursors({ 'folders.team.last_sync_at': '2026-07-01T00:00:00.000Z' });
    const applied = makeFolder(0, { space_id: 'cloud-space-1' });
    const parked = makeFolder(1, { space_id: 'cloud-space-unknown' });
    const later = makeFolder(2, { space_id: 'cloud-space-1' });
    mockSpaces.getByCloudId.mockImplementation((cloudId: string) =>
      cloudId === 'cloud-space-1' ? makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }) : null,
    );
    mockFetchFolders.mockResolvedValue([applied, parked, later]);

    await expect(pullFoldersTeam()).resolves.toBeUndefined();

    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledTimes(1);
    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledWith(applied, { spaceId: TEAM_SPACE_ID });
    // The unpaginated list replays in full next sync, so the cursor must not move.
    expect(mockRepo.setSyncState).not.toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      expect.anything(),
    );
    // ...but the park itself is recorded so a wedge becomes visible.
    expect(mockRepo.setSyncState).toHaveBeenCalledWith('folders.team.parked_row', `${parked.id}:1`);
    expect(Sentry.addBreadcrumb).toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('escalates to a warning once the same space parks three runs in a row', async () => {
    const parked = makeFolder(0, { space_id: 'cloud-space-unknown' });
    withCursors({ 'folders.team.parked_row': `${parked.id}:2` });
    mockSpaces.getByCloudId.mockReturnValue(null);
    mockFetchFolders.mockResolvedValue([parked]);

    await pullFoldersTeam();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('parked 3 consecutive syncs'),
      'warning',
    );
  });

  it('drops the local row for an access-removed stub, without touching its notes', async () => {
    const stub = makeStub(0);
    mockRepo.getFolderByRemoteId.mockReturnValue(makeLocalFolder(42));
    mockFetchFolders.mockResolvedValue([stub]);

    await pullFoldersTeam();

    expect(mockRepo.getFolderByRemoteId).toHaveBeenCalledWith(stub.id);
    // hardDeleteFolder is row-only: the folder's notes each arrive as their own
    // stub in the note pass, which knows how to keep unpushed local work.
    expect(mockRepo.hardDeleteFolder).toHaveBeenCalledWith(42);
    // Never an apply — a stub carries no name/sort_order, and applying one
    // would silently relocate a live folder into the private space.
    expect(mockRepo.applyRemoteFolder).not.toHaveBeenCalled();
    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      stub.updated_at,
    );
  });

  it('ignores a stub for a folder this device never mirrored — no insert, no throw', async () => {
    // The nightmare case: a stub has no name at all, so an INSERT would violate
    // folders.name NOT NULL and error out every sync run from here on.
    const stub = makeStub(0, { space_id: null, previous_space_id: null });
    mockRepo.getFolderByRemoteId.mockReturnValue(null);
    mockFetchFolders.mockResolvedValue([stub]);

    await expect(pullFoldersTeam()).resolves.toBeUndefined();

    expect(mockRepo.hardDeleteFolder).not.toHaveBeenCalled();
    expect(mockRepo.applyRemoteFolder).not.toHaveBeenCalled();
    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      stub.updated_at,
    );
  });

  it('never parks on a stub naming a space this device cannot resolve', async () => {
    // A revoked space is unresolvable by definition, so parking on one would
    // freeze the team cursor forever.
    const stub = makeStub(0, { space_id: 'cloud-space-revoked' });
    const later = makeFolder(1, { space_id: 'cloud-space-1' });
    mockSpaces.getByCloudId.mockImplementation((cloudId: string) =>
      cloudId === 'cloud-space-1' ? makeSpace({ id: TEAM_SPACE_ID, kind: 'team' }) : null,
    );
    mockRepo.getFolderByRemoteId.mockReturnValue(null);
    mockFetchFolders.mockResolvedValue([stub, later]);

    await pullFoldersTeam();

    expect(mockRepo.setSyncState).toHaveBeenCalledWith(
      'folders.team.last_sync_at',
      later.updated_at,
    );
    expect(mockRepo.setSyncState).not.toHaveBeenCalledWith(
      'folders.team.parked_row',
      `${stub.id}:1`,
    );
    // Rows after the stub are still applied — the pass ran to completion.
    expect(mockRepo.applyRemoteFolder).toHaveBeenCalledWith(later, { spaceId: TEAM_SPACE_ID });
  });

  it('clears the park streak once the pass completes without parking', async () => {
    withCursors({ 'folders.team.parked_row': 'srv-folder-0:2' });
    mockFetchFolders.mockResolvedValue([makeFolder(0, { space_id: 'cloud-space-1' })]);

    await pullFoldersTeam();

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('folders.team.parked_row', '');
  });
});
