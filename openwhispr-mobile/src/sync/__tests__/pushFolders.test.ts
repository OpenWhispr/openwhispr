jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/data', () => ({
  notesRepository: {
    getPendingFolders: jest.fn(),
    getFolders: jest.fn(),
    hardDeleteFolder: jest.fn(),
    finalizeFolderDelete: jest.fn(),
    revertFolderDelete: jest.fn(),
    markFolderPushed: jest.fn(),
    markFolderTerminal: jest.fn(),
    adoptDuplicateFolder: jest.fn(),
    getSyncState: jest.fn(),
  },
  spacesRepository: {
    listSpaces: jest.fn(),
    getPrivateSpace: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  batchCreateFolders: jest.fn(),
  updateFolder: jest.fn(),
  deleteFolder: jest.fn(),
}));

import { pushFolders } from '../pushFolders';
import { notesRepository, spacesRepository } from '@/data';
import { batchCreateFolders, updateFolder, deleteFolder } from '@/data/remote/notesApi';
import * as Sentry from '@sentry/react-native';
import { FOLDER_NAME_TAKEN_CODE } from '../pushErrorCodes';
import type { Folder } from '@/data/types';
import type { Space } from '@/data';

const mockNotesRepository = notesRepository as jest.Mocked<typeof notesRepository>;
const mockListSpaces = spacesRepository.listSpaces as jest.Mock;
const mockGetPrivateSpace = spacesRepository.getPrivateSpace as jest.Mock;
const mockBatchCreateFolders = batchCreateFolders as jest.Mock;
const mockUpdateFolder = updateFolder as jest.Mock;
const mockDeleteFolder = deleteFolder as jest.Mock;
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;
const mockCaptureException = Sentry.captureException as jest.Mock;
const mockAddBreadcrumb = Sentry.addBreadcrumb as jest.Mock;

const folder = (overrides: Partial<Folder> = {}): Folder =>
  ({
    id: 1,
    name: 'Meetings',
    isDefault: 0,
    sortOrder: 0,
    clientFolderId: 'client-folder-1',
    remoteId: null,
    deletedAt: null,
    pendingSync: 1,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Folder;

describe('pushFolders create response matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getPendingFolders.mockReturnValue([]);
  });

  it('matches responses by client_folder_id even when the server returns them out of order', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, clientFolderId: 'client-folder-1' }),
      folder({ id: 2, clientFolderId: 'client-folder-2' }),
    ]);
    // Server returns folder 2's row first — a naive positional match would swap them.
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'remote-folder-2',
        client_folder_id: 'client-folder-2',
        name: 'Folder 2',
        is_default: false,
        sort_order: 0,
        deleted_at: null,
        updated_at: '2026-08-24T10:00:00.000Z',
      },
      {
        id: 'remote-folder-1',
        client_folder_id: 'client-folder-1',
        name: 'Folder 1',
        is_default: false,
        sort_order: 0,
        deleted_at: null,
        updated_at: '2026-08-24T11:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'remote-folder-1',
      '2026-08-24T11:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      2,
      'remote-folder-2',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('falls back to positional index when a response row carries no client_folder_id', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, clientFolderId: 'client-folder-1' }),
    ]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'remote-folder-1',
        client_folder_id: null,
        name: 'Folder 1',
        is_default: false,
        sort_order: 0,
        deleted_at: null,
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'remote-folder-1',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('warns and skips a create row with neither a client_folder_id match nor a positional fallback', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, clientFolderId: 'client-folder-1' }),
      folder({ id: 2, clientFolderId: 'client-folder-2' }),
    ]);
    // Server only returns folder 1's row (partial rejection of folder 2). Folder 1
    // matches by client_folder_id; folder 2 has no id match and no row at its
    // positional index to fall back to, so it must be reported unmatched rather
    // than silently stealing folder 1's response.
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'remote-folder-1',
        client_folder_id: 'client-folder-1',
        name: 'Folder 1',
        is_default: false,
        sort_order: 0,
        deleted_at: null,
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'remote-folder-1',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'pushFolders: 1/2 create rows had no matching server response',
      'warning',
    );
  });
});

describe('pushFolders POLICY_CLOUD_BACKUP_BLOCKED propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getPendingFolders.mockReturnValue([]);
  });

  it('rethrows a create 403+POLICY_CLOUD_BACKUP_BLOCKED as-is, marking nothing pushed', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1' }),
    ]);
    mockBatchCreateFolders.mockRejectedValue({
      status: 403,
      code: 'POLICY_CLOUD_BACKUP_BLOCKED',
      message: 'blocked',
    });

    await expect(pushFolders()).rejects.toMatchObject({
      status: 403,
      code: 'POLICY_CLOUD_BACKUP_BLOCKED',
    });

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows an update 403+POLICY_CLOUD_BACKUP_BLOCKED, leaving the row untouched', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: 'remote-folder-1' }),
    ]);
    mockUpdateFolder.mockRejectedValue({ status: 403, code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    await expect(pushFolders()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('rethrows a delete 403+POLICY_CLOUD_BACKUP_BLOCKED, leaving the row untouched', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: 'remote-folder-1', deletedAt: '2026-08-24T09:00:00.000Z' }),
    ]);
    mockDeleteFolder.mockRejectedValue({ status: 403, code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    await expect(pushFolders()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockNotesRepository.hardDeleteFolder).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('a blocked create stops the run before any update runs', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1' }),
      folder({ id: 2, remoteId: 'remote-folder-2' }),
    ]);
    mockBatchCreateFolders.mockRejectedValue({ status: 403, code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    await expect(pushFolders()).rejects.toMatchObject({ code: 'POLICY_CLOUD_BACKUP_BLOCKED' });

    expect(mockUpdateFolder).not.toHaveBeenCalled();
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

describe('pushFolders scope fields (Task 8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getPendingFolders.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockReturnValue('true');
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE, TEAM_SPACE_SKELETON]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'remote-folder-1',
        client_folder_id: 'client-folder-1',
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);
    mockUpdateFolder.mockResolvedValue({
      id: 'remote-folder-2',
      updated_at: '2026-08-24T10:00:00.000Z',
    });
  });

  it('sends the team space identity on create', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: TEAM_SPACE.id }),
    ]);

    await pushFolders();

    expect(mockBatchCreateFolders).toHaveBeenCalledWith([
      expect.objectContaining({ workspace_id: 'workspace-9', space_id: 'cloud-space-2' }),
    ]);
  });

  it('sends NO scope fields on an update, whatever space the folder sits in', async () => {
    // Folders have no base_updated_at to guard a scope claim with, and mobile
    // has no folder-move feature: an omitted space_id leaves the server's scope
    // untouched, which is the only safe thing a rename can say.
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: TEAM_SPACE.id }),
      folder({ id: 3, remoteId: 'remote-folder-3', spaceId: PRIVATE_SPACE.id }),
    ]);

    await pushFolders();

    expect(mockUpdateFolder).toHaveBeenCalledTimes(2);
    for (const [, payload] of mockUpdateFolder.mock.calls) {
      expect('space_id' in payload).toBe(false);
      expect('workspace_id' in payload).toBe(false);
      expect(payload).toEqual({ name: 'Meetings', sort_order: 0 });
    }
  });

  it('sends explicit nulls on a private-space create so it lands as personal', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        clientFolderId: 'client-folder-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);

    await pushFolders();

    expect(mockBatchCreateFolders).toHaveBeenCalledWith([
      expect.objectContaining({ workspace_id: null, space_id: null }),
    ]);
  });

  it('omits both keys entirely when the backend has no team-spaces capability', async () => {
    mockNotesRepository.getSyncState.mockReturnValue(null);
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: TEAM_SPACE.id }),
    ]);

    await pushFolders();

    const payload = mockBatchCreateFolders.mock.calls[0][0][0];
    expect('space_id' in payload).toBe(false);
    expect('workspace_id' in payload).toBe(false);
  });

  it('skips a folder whose space no longer resolves, leaving it pending', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: 999 }),
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: 999 }),
    ]);

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockUpdateFolder).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'info' }),
    );
  });

  it('skips a folder whose team space has no cloud id yet, leaving it pending', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        clientFolderId: 'client-folder-1',
        spaceId: TEAM_SPACE_SKELETON.id,
      }),
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: TEAM_SPACE_SKELETON.id }),
    ]);

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockUpdateFolder).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'sync', level: 'info' }),
    );
  });

  it('still deletes a folder whose team space has no cloud id (DELETE carries no scope)', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        spaceId: TEAM_SPACE_SKELETON.id,
        deletedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockNotesRepository.finalizeFolderDelete).toHaveBeenCalledWith(1);
  });
});

describe('pushFolders code-aware error recovery (Task 8)', () => {
  const TERMINAL_CODES = [
    ['team_not_found', 404],
    ['team_access_revoked', 403],
    ['team_archived', 410],
    ['space_not_found', 404],
    ['space_access_revoked', 403],
    ['space_archived', 410],
    ['folder_access_denied', 403],
  ] as const;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getPendingFolders.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockReturnValue('true');
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE]);
  });

  it.each(TERMINAL_CODES)(
    '%s on update clears the folder pendingSync, leaves the row as-is, and does not fail the pass',
    async (code, status) => {
      mockNotesRepository.getPendingFolders.mockReturnValue([
        folder({ id: 2, remoteId: 'remote-folder-2', spaceId: TEAM_SPACE.id }),
      ]);
      mockUpdateFolder.mockRejectedValue({ status, code, message: code });

      await expect(pushFolders()).resolves.toBeUndefined();

      expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(2);
      expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
      expect(mockNotesRepository.hardDeleteFolder).not.toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'sync', level: 'warning' }),
      );
    },
  );

  // A delete has already tombstoned the folder AND its notes locally (the
  // server's own cascade, applied optimistically), so a refusal cannot just
  // "leave the row as-is" the way a create or update does — it has to undo.
  it.each(TERMINAL_CODES)(
    '%s on delete restores the folder and its cascaded notes instead of settling',
    async (code, status) => {
      mockNotesRepository.getPendingFolders.mockReturnValue([
        folder({
          id: 1,
          remoteId: 'remote-folder-1',
          spaceId: TEAM_SPACE.id,
          deletedAt: '2026-08-24T12:00:00.000Z',
        }),
      ]);
      mockDeleteFolder.mockRejectedValue({ status, code, message: code });

      await expect(pushFolders()).resolves.toBeUndefined();

      expect(mockNotesRepository.revertFolderDelete).toHaveBeenCalledWith(1);
      expect(mockNotesRepository.finalizeFolderDelete).not.toHaveBeenCalled();
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'sync', level: 'warning' }),
      );
    },
  );

  it('an uncoded 404 on delete settles it — the folder is already gone server-side', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: 'remote-folder-1',
        deletedAt: '2026-08-24T12:00:00.000Z',
      }),
    ]);
    mockDeleteFolder.mockRejectedValue({ status: 404, message: 'Not found' });

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockNotesRepository.finalizeFolderDelete).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.revertFolderDelete).not.toHaveBeenCalled();
  });

  it('a transient error on delete leaves the cascade in place for the next pass', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: 'remote-folder-1',
        deletedAt: '2026-08-24T12:00:00.000Z',
      }),
    ]);
    mockDeleteFolder.mockRejectedValue({ status: 500, message: 'boom' });

    // The pass still reports the failure so the run retries; what matters here is
    // that neither verdict was applied to the cascade.
    await expect(pushFolders()).rejects.toThrow('1 operation(s) failed');

    expect(mockNotesRepository.finalizeFolderDelete).not.toHaveBeenCalled();
    expect(mockNotesRepository.revertFolderDelete).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('a space-access code on create settles every row in the batch', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: TEAM_SPACE.id }),
      folder({ id: 2, remoteId: null, clientFolderId: 'client-folder-2', spaceId: TEAM_SPACE.id }),
    ]);
    mockBatchCreateFolders.mockRejectedValue({ status: 403, code: 'space_access_revoked' });

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(1);
    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(2);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('folder_name_taken (409) stays retryable: pendingSync survives and the pass reports the failure', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: TEAM_SPACE.id }),
    ]);
    mockUpdateFolder.mockRejectedValue({
      status: 409,
      code: FOLDER_NAME_TAKEN_CODE,
      message: 'Name taken',
    });

    await expect(pushFolders()).rejects.toThrow('pushFolders: 1 operation(s) failed');

    // Never terminal: the collision clears once the user or another device
    // renames one of the two folders, and the retry then succeeds.
    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
  });

  it('folder_name_taken (409) on create also stays retryable', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: TEAM_SPACE.id }),
    ]);
    mockBatchCreateFolders.mockRejectedValue({ status: 409, code: FOLDER_NAME_TAKEN_CODE });

    await expect(pushFolders()).rejects.toThrow('pushFolders: 1 operation(s) failed');

    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
  });

  it('an uncoded 5xx keeps the pre-existing retry behavior', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: PRIVATE_SPACE.id }),
    ]);
    mockUpdateFolder.mockRejectedValue({ status: 500, message: 'boom' });

    await expect(pushFolders()).rejects.toThrow('pushFolders: 1 operation(s) failed');

    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: { sync: 'pushFolders.update' } }),
    );
  });
});

describe('pushFolders scope-grouped create batching (Task 8 fix round 2)', () => {
  // The server validates every distinct space in a batch-create body before
  // inserting anything, so one revoked space would otherwise settle healthy
  // rows — and a folder marked terminal strands its notes at the cloud root.
  type CreateItem = { client_folder_id: string; space_id?: string | null };

  const createdFor = async (items: CreateItem[]) =>
    items.map((i) => ({
      id: `remote-${i.client_folder_id}`,
      client_folder_id: i.client_folder_id,
      name: 'Meetings',
      is_default: false,
      sort_order: 0,
      deleted_at: null,
      updated_at: '2026-08-24T10:00:00.000Z',
    }));

  const spaceIdsIn = (call: CreateItem[]): (string | null | undefined)[] => [
    ...new Set(call.map((i) => i.space_id)),
  ];

  const pendingCreate = (id: number, spaceId: number): Folder =>
    folder({ id, remoteId: null, clientFolderId: `client-folder-${id}`, spaceId });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getPendingFolders.mockReturnValue([]);
    mockNotesRepository.getSyncState.mockReturnValue('true');
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE, TEAM_SPACE_B]);
    mockBatchCreateFolders.mockImplementation(createdFor);
  });

  it('splits pending creates across personal and two team spaces into one request per scope', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
      pendingCreate(3, TEAM_SPACE_B.id),
      pendingCreate(4, TEAM_SPACE.id),
    ]);

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockBatchCreateFolders).toHaveBeenCalledTimes(3);
    const calls = mockBatchCreateFolders.mock.calls.map((c) => c[0] as CreateItem[]);
    for (const call of calls) expect(spaceIdsIn(call)).toHaveLength(1);
    expect(new Set(calls.map((call) => spaceIdsIn(call)[0]))).toEqual(
      new Set([null, 'cloud-space-2', 'cloud-space-4']),
    );
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(4);
  });

  it('chunks a single scope bucket at the 50-folder server cap', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      ...Array.from({ length: 51 }, (_, idx) => pendingCreate(idx + 1, TEAM_SPACE.id)),
      pendingCreate(52, PRIVATE_SPACE.id),
    ]);

    await expect(pushFolders()).resolves.toBeUndefined();

    const calls = mockBatchCreateFolders.mock.calls.map((c) => c[0] as CreateItem[]);
    expect(calls.map((call) => call.length)).toEqual([50, 1, 1]);
    expect(calls.map((call) => spaceIdsIn(call)[0])).toEqual([
      'cloud-space-2',
      'cloud-space-2',
      null,
    ]);
  });

  it('settles only the revoked space’s bucket; the other team space and personal rows still push', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
      pendingCreate(3, TEAM_SPACE_B.id),
      pendingCreate(4, TEAM_SPACE.id),
    ]);
    mockBatchCreateFolders.mockImplementation(async (items: CreateItem[]) => {
      if (items[0].space_id === TEAM_SPACE.cloudSpaceId) {
        throw { status: 403, code: 'space_access_revoked', message: 'revoked' };
      }
      return createdFor(items);
    });

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledTimes(2);
    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(2);
    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(4);
    // The healthy space's folder and the personal folder are untouched by it.
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(2);
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'remote-client-folder-1',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      3,
      'remote-client-folder-3',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('treats a space-access code on the personal bucket as retryable and never settles it', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      pendingCreate(1, PRIVATE_SPACE.id),
      pendingCreate(2, TEAM_SPACE.id),
    ]);
    mockBatchCreateFolders.mockImplementation(async (items: CreateItem[]) => {
      if (items[0].space_id == null) {
        throw { status: 404, code: 'space_not_found', message: 'gone' };
      }
      return createdFor(items);
    });

    await expect(pushFolders()).rejects.toThrow('pushFolders: 1 operation(s) failed');

    expect(mockNotesRepository.markFolderTerminal).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'sync',
        level: 'warning',
        message: expect.stringContaining('personal-scope create chunk'),
      }),
    );
    // The team bucket in the same pass is unaffected.
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      2,
      'remote-client-folder-2',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('still settles a personal bucket on a per-row permission denial (evidence about this write)', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([pendingCreate(1, PRIVATE_SPACE.id)]);
    mockBatchCreateFolders.mockRejectedValue({ status: 403, code: 'folder_access_denied' });

    await expect(pushFolders()).resolves.toBeUndefined();

    expect(mockNotesRepository.markFolderTerminal).toHaveBeenCalledWith(1);
  });
});

describe('pushFolders teamOnly filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getSyncState.mockReturnValue('true');
    mockListSpaces.mockReturnValue([PRIVATE_SPACE, TEAM_SPACE]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'remote-folder-2',
        client_folder_id: 'client-folder-2',
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);
    mockUpdateFolder.mockResolvedValue({
      id: 'remote-folder-3',
      updated_at: '2026-08-24T10:00:00.000Z',
    });
  });

  it('default (no argument) pushes every pending row, private and team alike — unchanged behavior', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        clientFolderId: 'client-folder-1',
        spaceId: PRIVATE_SPACE.id,
      }),
      folder({ id: 2, remoteId: null, clientFolderId: 'client-folder-2', spaceId: TEAM_SPACE.id }),
    ]);
    mockBatchCreateFolders.mockImplementation(async (items: { client_folder_id: string }[]) =>
      items.map((i) => ({
        id: `remote-${i.client_folder_id}`,
        client_folder_id: i.client_folder_id,
        updated_at: '2026-08-24T10:00:00.000Z',
      })),
    );

    await pushFolders();

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(2);
  });

  it('teamOnly=true pushes only the team-space row, leaving the private one pending', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        clientFolderId: 'client-folder-1',
        spaceId: PRIVATE_SPACE.id,
      }),
      folder({ id: 2, remoteId: null, clientFolderId: 'client-folder-2', spaceId: TEAM_SPACE.id }),
    ]);

    await pushFolders(true);

    expect(mockBatchCreateFolders).toHaveBeenCalledTimes(1);
    expect(mockBatchCreateFolders).toHaveBeenCalledWith([
      expect.objectContaining({ client_folder_id: 'client-folder-2' }),
    ]);
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      2,
      'remote-folder-2',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('teamOnly=true still pushes a team-space update, but never a private-space one', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 2, remoteId: 'remote-folder-2', spaceId: TEAM_SPACE.id }),
      folder({ id: 3, remoteId: 'remote-folder-3', spaceId: PRIVATE_SPACE.id }),
    ]);
    mockUpdateFolder.mockResolvedValue({
      id: 'remote-folder-2',
      updated_at: '2026-08-24T10:00:00.000Z',
    });

    await pushFolders(true);

    expect(mockUpdateFolder).toHaveBeenCalledTimes(1);
    expect(mockUpdateFolder).toHaveBeenCalledWith('remote-folder-2', expect.anything());
  });

  it('teamOnly=true drops a row with no space (space_id null) — that is a personal-scope signal', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 1, remoteId: null, clientFolderId: 'client-folder-1', spaceId: null }),
    ]);

    await pushFolders(true);

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
  });

  it('teamOnly=true is a no-op (no network calls) when nothing pending is team-scoped', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        clientFolderId: 'client-folder-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);

    await pushFolders(true);

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockUpdateFolder).not.toHaveBeenCalled();
    expect(mockDeleteFolder).not.toHaveBeenCalled();
  });

  // Fix round 1, Finding 2: a pending delete carries no scope and must flow
  // in teamOnly mode exactly like full mode — including when its space was
  // revoked earlier in the SAME run (isTeamRow would otherwise stop
  // recognizing it, since the revoked space no longer appears in listSpaces).
  it('teamOnly=true still pushes a delete for a row whose space is no longer in listSpaces (revoked this run)', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: 'remote-folder-1',
        deletedAt: '2026-08-24T12:00:00.000Z',
        spaceId: 999,
      }),
    ]);
    mockDeleteFolder.mockResolvedValue(undefined);

    await pushFolders(true);

    expect(mockDeleteFolder).toHaveBeenCalledWith('remote-folder-1');
    expect(mockNotesRepository.finalizeFolderDelete).toHaveBeenCalledWith(1);
  });

  it('teamOnly=true still settles a never-pushed row (remoteId null) regardless of space', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        remoteId: null,
        deletedAt: '2026-08-24T12:00:00.000Z',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);

    await pushFolders(true);

    expect(mockDeleteFolder).not.toHaveBeenCalled();
    expect(mockNotesRepository.finalizeFolderDelete).toHaveBeenCalledWith(1);
  });
});

// Fix round 1, Finding 1 (Critical): backfill can mint a client id for a
// local default folder and then the run ends before pushFolders lands;
// another device creates its own same-named default folder server-side; the
// next run's pullFolders (backfill's flag is already set) inserts that as a
// SECOND local row, matched only by client/remote id — never by name — so
// this device now has two local "Personal" rows, one of them permanently
// unpushable (folder_name_taken, 409, retryable forever, which throws and
// blocks pushNotes from ever running in the same pass). pushFolders must
// adopt instead of create in that shape.
describe('pushFolders default-folder duplicate adoption (fix round 1, Finding 1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesRepository.getSyncState.mockReturnValue(null);
    mockGetPrivateSpace.mockReturnValue({ id: PRIVATE_SPACE.id } as Space);
  });

  it('adopts a same-named already-synced private-scope duplicate instead of creating — batchCreateFolders is never called', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Personal',
        isDefault: 1,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockNotesRepository.getFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Personal',
        isDefault: 1,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
      folder({
        id: 7,
        name: 'Personal',
        isDefault: 1,
        remoteId: 'srv-desktop-personal',
        clientFolderId: 'desktop-client-1',
        spaceId: PRIVATE_SPACE.id,
        updatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await pushFolders();

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockNotesRepository.adoptDuplicateFolder).toHaveBeenCalledWith(
      1,
      7,
      'srv-desktop-personal',
      '2026-08-24T09:00:00.000Z',
    );
    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
  });

  it('matches the duplicate name case-insensitively', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'personal',
        isDefault: 1,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockNotesRepository.getFolders.mockReturnValue([
      folder({ id: 1, name: 'personal', isDefault: 1, remoteId: null, spaceId: PRIVATE_SPACE.id }),
      folder({
        id: 7,
        name: 'PERSONAL',
        isDefault: 1,
        remoteId: 'srv-desktop-personal',
        spaceId: PRIVATE_SPACE.id,
        updatedAt: '2026-08-24T09:00:00.000Z',
      }),
    ]);

    await pushFolders();

    expect(mockBatchCreateFolders).not.toHaveBeenCalled();
    expect(mockNotesRepository.adoptDuplicateFolder).toHaveBeenCalledWith(
      1,
      7,
      'srv-desktop-personal',
      '2026-08-24T09:00:00.000Z',
    );
  });

  it('creates normally when no duplicate exists — the common case is unaffected', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Personal',
        isDefault: 1,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockNotesRepository.getFolders.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1, remoteId: null, spaceId: PRIVATE_SPACE.id }),
    ]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'srv-1',
        client_folder_id: 'mobile-client-1',
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockBatchCreateFolders).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.adoptDuplicateFolder).not.toHaveBeenCalled();
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
      expect.objectContaining({ id: expect.any(Number) }),
    );
  });

  it('never adopts a non-default folder create, even with a same-named already-synced folder', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Client Work',
        isDefault: 0,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockNotesRepository.getFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Client Work',
        isDefault: 0,
        remoteId: null,
        spaceId: PRIVATE_SPACE.id,
      }),
      folder({
        id: 7,
        name: 'Client Work',
        isDefault: 0,
        remoteId: 'srv-client-work',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'srv-new',
        client_folder_id: 'mobile-client-1',
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockNotesRepository.adoptDuplicateFolder).not.toHaveBeenCalled();
    expect(mockBatchCreateFolders).toHaveBeenCalledTimes(1);
  });

  it('never adopts a duplicate that sits in a team space, even with a matching private default name', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({
        id: 1,
        name: 'Personal',
        isDefault: 1,
        remoteId: null,
        clientFolderId: 'mobile-client-1',
        spaceId: PRIVATE_SPACE.id,
      }),
    ]);
    mockNotesRepository.getFolders.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1, remoteId: null, spaceId: PRIVATE_SPACE.id }),
      folder({
        id: 7,
        name: 'Personal',
        isDefault: 1,
        remoteId: 'srv-team-personal',
        spaceId: TEAM_SPACE.id,
      }),
    ]);
    mockBatchCreateFolders.mockResolvedValue([
      {
        id: 'srv-new',
        client_folder_id: 'mobile-client-1',
        updated_at: '2026-08-24T10:00:00.000Z',
      },
    ]);

    await pushFolders();

    expect(mockNotesRepository.adoptDuplicateFolder).not.toHaveBeenCalled();
    expect(mockBatchCreateFolders).toHaveBeenCalledTimes(1);
  });

  it('reads getFolders lazily — never calls it when nothing pending is a default-folder create', async () => {
    mockNotesRepository.getPendingFolders.mockReturnValue([
      folder({ id: 2, remoteId: 'remote-folder-2', isDefault: 0, spaceId: PRIVATE_SPACE.id }),
    ]);
    mockUpdateFolder.mockResolvedValue({
      id: 'remote-folder-2',
      updated_at: '2026-08-24T10:00:00.000Z',
    });

    await pushFolders();

    expect(mockNotesRepository.getFolders).not.toHaveBeenCalled();
    expect(mockGetPrivateSpace).not.toHaveBeenCalled();
  });
});
