import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import type { RemoteFolder } from '@/data/types';

let mockRepo: LocalNotesRepository;
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
}));
jest.mock('@/data/remote/notesApi', () => ({ fetchFolders: jest.fn() }));

import { fetchFolders } from '@/data/remote/notesApi';
import { pullFolders } from '../pullFolders';

const LAST_SYNC = '2026-11-13T12:00:00.000Z';
const DELETED_AT = '2026-11-14T12:00:00.000Z';
const LATEST_UPDATE = '2026-11-15T12:00:00.000Z';
const deletedFolder: RemoteFolder = {
  id: 'deleted-folder',
  client_folder_id: 'deleted-client',
  name: 'Deleted on desktop',
  private_workspace_id: 'workspace-A',
  workspace_id: null,
  space_id: null,
  is_default: false,
  sort_order: 0,
  deleted_at: DELETED_AT,
  updated_at: DELETED_AT,
};
const liveFolder: RemoteFolder = {
  ...deletedFolder,
  id: 'live-folder',
  client_folder_id: 'live-client',
  name: 'Other workspace',
  private_workspace_id: 'workspace-B',
  deleted_at: null,
  updated_at: LATEST_UPDATE,
};

beforeEach((): void => {
  jest.resetAllMocks();
  mockRepo = createMemoryRepository().repo;
  mockRepo.applyRemoteFolder({ ...deletedFolder, deleted_at: null, updated_at: LAST_SYNC });
  mockRepo.setSyncState('folders.last_sync_at', LAST_SYNC);
  // The API's browse response omits tombstones; only a delta cursor returns them.
  jest
    .mocked(fetchFolders)
    .mockImplementation(
      async (since): Promise<RemoteFolder[]> =>
        since == null
          ? [liveFolder]
          : [deletedFolder, liveFolder].filter((folder) => folder.updated_at >= since),
    );
});

it.each(['incremental', 'placement replay'])(
  'removes remote-deleted folders during %s before advancing the cursor',
  async (mode): Promise<void> => {
    if (mode === 'placement replay') mockRepo.clearSyncState('folders.last_sync_at');

    await pullFolders();

    expect(mockRepo.getFolderByRemoteId(deletedFolder.id)).toBeNull();
    expect(mockRepo.getFolderByRemoteId(liveFolder.id)).toMatchObject({
      privateWorkspaceId: 'workspace-B',
      name: 'Other workspace',
    });
    expect(mockRepo.getSyncState('folders.last_sync_at')).toBe(LATEST_UPDATE);
    expect(fetchFolders).toHaveBeenCalledWith(
      mode === 'placement replay' ? '1970-01-01T00:00:00.000Z' : LAST_SYNC,
    );

    await pullFolders();

    expect(fetchFolders).toHaveBeenLastCalledWith(LATEST_UPDATE);
    expect(mockRepo.getFolderByRemoteId(deletedFolder.id)).toBeNull();
  },
);
