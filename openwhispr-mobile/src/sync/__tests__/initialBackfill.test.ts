// initialBackfill.ts runs once per (device DB, userId): it assigns client ids
// to any local folder/note that doesn't have one yet, adopting a matching
// private-scope server default folder by name instead of minting a duplicate
// create. These tests demonstrate that mechanism covers every path that can
// reach it with local defaults missing a client id — fresh install, reinstall
// with existing cloud data, and sign-in after offline use all collapse into
// the same starting shape (flag unset, local default folders with no client
// id) — plus Requirement 2's private-scope restriction on the name match.
jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    getFoldersMissingClientId: jest.fn(),
    getNotesMissingClientId: jest.fn(),
    setFolderClientId: jest.fn(),
    setNoteClientId: jest.fn(),
    markFolderPushed: jest.fn(),
  },
  spacesRepository: {
    getPrivateSpace: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  fetchFolders: jest.fn(),
}));

import { runInitialBackfillIfNeeded } from '../initialBackfill';
import { notesRepository, spacesRepository } from '@/data';
import { fetchFolders } from '@/data/remote/notesApi';
import type { Folder, Note, RemoteFolder } from '@/data/types';
import type { Space } from '@/data';

const mockNotesRepository = notesRepository as jest.Mocked<typeof notesRepository>;
const mockGetPrivateSpace = spacesRepository.getPrivateSpace as jest.Mock;
const mockFetchFolders = fetchFolders as jest.Mock;

const PRIVATE_SPACE_ID = 1;
const TEAM_SPACE_ID = 2;

const folder = (overrides: Partial<Folder> = {}): Folder =>
  ({
    id: 1,
    name: 'Personal',
    isDefault: 1,
    sortOrder: 0,
    clientFolderId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    spaceId: PRIVATE_SPACE_ID,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Folder;

const note = (overrides: Partial<Note> = {}): Note =>
  ({
    id: 1,
    title: 'Untitled',
    content: '',
    folderId: null,
    noteType: 'personal',
    sourceFile: null,
    audioDurationSeconds: null,
    enhancedContent: null,
    enhancementPrompt: null,
    enhancedAtContentHash: null,
    clientNoteId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    isPrivate: 0,
    spaceId: PRIVATE_SPACE_ID,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Note;

const remoteFolder = (overrides: Partial<RemoteFolder> = {}): RemoteFolder => ({
  id: 'srv-folder-1',
  client_folder_id: 'server-client-1',
  name: 'Personal',
  is_default: true,
  sort_order: 0,
  deleted_at: null,
  updated_at: '2026-08-24T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPrivateSpace.mockReturnValue({ id: PRIVATE_SPACE_ID } as Space);
  mockNotesRepository.getSyncState.mockReturnValue(null);
  mockNotesRepository.getFoldersMissingClientId.mockReturnValue([]);
  mockNotesRepository.getNotesMissingClientId.mockReturnValue([]);
  mockFetchFolders.mockResolvedValue([]);
});

describe('runInitialBackfillIfNeeded — once-per-account guard', () => {
  it('does nothing when the flag is already set for this userId', async () => {
    mockNotesRepository.getSyncState.mockReturnValue('1');

    await runInitialBackfillIfNeeded('user-1');

    expect(mockFetchFolders).not.toHaveBeenCalled();
    expect(mockNotesRepository.getFoldersMissingClientId).not.toHaveBeenCalled();
    expect(mockNotesRepository.setSyncState).not.toHaveBeenCalled();
  });

  it('runs once and sets the per-user flag when it was unset', async () => {
    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.getSyncState).toHaveBeenCalledWith('initial_backfill_done.user-1');
    expect(mockNotesRepository.setSyncState).toHaveBeenCalledWith(
      'initial_backfill_done.user-1',
      '1',
    );
  });

  it('keys the flag per userId, so a different account on the same device backfills independently', async () => {
    mockNotesRepository.getSyncState.mockImplementation((key: string) =>
      key === 'initial_backfill_done.user-1' ? '1' : null,
    );

    await runInitialBackfillIfNeeded('user-2');

    expect(mockFetchFolders).toHaveBeenCalled();
    expect(mockNotesRepository.setSyncState).toHaveBeenCalledWith(
      'initial_backfill_done.user-2',
      '1',
    );
  });
});

// Requirement 1: a default folder name never produces a second server-side
// create when a private server folder with that name already exists. Fresh
// install, reinstall with existing cloud data, and sign-in after offline use
// all reach runInitialBackfillIfNeeded in the identical starting shape (flag
// unset for this userId, local default folders with no client id yet) — so
// one mechanism, exercised once per scenario below, covers all three.
describe('default-folder adoption invariant (Requirement 1)', () => {
  it('fresh install: adopts a same-named private-scope server default instead of minting a create', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Personal' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    // Adopted: the local default is pointed at the server row's own identity
    // and immediately acked (markFolderPushed clears pendingSync), so it is
    // never a candidate for pushFolders' CREATE path — no duplicate create.
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
    );
  });

  it('matches the default folder name case-insensitively', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'PERSONAL' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'personal', isDefault: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
    );
  });

  it('re-install with existing cloud data: adopts both default folders from a brand-new local DB', async () => {
    // A reinstall starts from a fresh local DB (default folders reseeded, no
    // client ids) signing back into an account whose cloud already has these
    // default folders — from this device's earlier install, or from desktop.
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Personal' }),
      remoteFolder({
        id: 'srv-2',
        client_folder_id: 'server-client-2',
        name: 'Meetings',
        updated_at: '2026-08-24T11:00:00.000Z',
      }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1, sortOrder: 0 }),
      folder({ id: 2, name: 'Meetings', isDefault: 1, sortOrder: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
    );
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      2,
      'srv-2',
      '2026-08-24T11:00:00.000Z',
    );
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(2);
  });

  it('sign-in after offline use: adopts pre-existing local default folders the same way', async () => {
    // These local rows existed before sign-in (created while offline/guest) —
    // same starting shape as fresh install/reinstall: is_default=1, no
    // client id, no remote id yet.
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Personal' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
    );
  });

  it('genuinely new account (no cloud folders yet): mints a fresh client id instead of adopting — nothing to adopt', async () => {
    mockFetchFolders.mockResolvedValue([]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockNotesRepository.setFolderClientId).toHaveBeenCalledWith(1, expect.any(String));
  });

  it('does not adopt a same-named remote folder that is not itself a default folder', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({
        id: 'srv-1',
        client_folder_id: 'server-client-1',
        name: 'Personal',
        is_default: false,
      }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockNotesRepository.setFolderClientId).toHaveBeenCalledWith(1, expect.any(String));
  });

  it('never adopts a non-default local folder, even with a same-named default remote folder', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Client Work' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 5, name: 'Client Work', isDefault: 0 }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockNotesRepository.setFolderClientId).toHaveBeenCalledWith(5, expect.any(String));
  });
});

// Requirement 2: name-based adoption must be restricted to the private
// scope — a team folder is matched by cloud id only (Task 7), so matching by
// name here could mis-adopt an unrelated team folder that happens to share a
// private default folder's name.
describe('name-based adoption is restricted to the private scope (Requirement 2)', () => {
  it('never adopts a local folder that sits in a team space, even with a matching private default name', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Personal' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 9, name: 'Personal', isDefault: 1, spaceId: TEAM_SPACE_ID }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).not.toHaveBeenCalled();
    expect(mockNotesRepository.setFolderClientId).toHaveBeenCalledWith(9, expect.any(String));
  });

  it('still adopts a private-space row in the same run a team-space row (same name) is skipped', async () => {
    mockFetchFolders.mockResolvedValue([
      remoteFolder({ id: 'srv-1', client_folder_id: 'server-client-1', name: 'Personal' }),
    ]);
    mockNotesRepository.getFoldersMissingClientId.mockReturnValue([
      folder({ id: 1, name: 'Personal', isDefault: 1, spaceId: PRIVATE_SPACE_ID }),
      folder({ id: 9, name: 'Personal', isDefault: 1, spaceId: TEAM_SPACE_ID }),
    ]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledTimes(1);
    expect(mockNotesRepository.markFolderPushed).toHaveBeenCalledWith(
      1,
      'srv-1',
      '2026-08-24T10:00:00.000Z',
    );
  });
});

describe('note client ids', () => {
  it('mints a fresh client id for every note missing one', async () => {
    mockNotesRepository.getNotesMissingClientId.mockReturnValue([note({ id: 7 })]);

    await runInitialBackfillIfNeeded('user-1');

    expect(mockNotesRepository.setNoteClientId).toHaveBeenCalledWith(7, expect.any(String));
  });
});
