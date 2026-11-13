import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import type { LocalNotesRepository } from '@/data/local/notesRepository';
import { LocalSpacesRepository } from '@/data/local/spacesRepository';
import type { RemoteFolder, RemoteNote } from '@/data/types';

let mockRepo: LocalNotesRepository;
let mockSpaces: LocalSpacesRepository;
jest.mock('@/data', () => ({
  get notesRepository() {
    return mockRepo;
  },
  get spacesRepository() {
    return mockSpaces;
  },
}));
jest.mock('@sentry/react-native', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'account' }, sessionCookie: 'session' }) },
}));
jest.mock('@/data/remote/notesApi', () => ({
  batchCreateFolders: jest.fn(),
  batchCreateNotes: jest.fn(),
  deleteNote: jest.fn(),
}));

import { batchCreateFolders, batchCreateNotes, deleteNote } from '@/data/remote/notesApi';
import { deletePrivateNoteCloudCopy } from '../privateNoteDeletion';
import { pushFolders } from '../pushFolders';
import { pushNotes } from '../pushNotes';

const SERVER_TIME = '2026-11-13T12:00:00.000Z';

function remoteFolder(overrides: Partial<RemoteFolder> = {}): RemoteFolder {
  return {
    id: 'remote-A',
    client_folder_id: 'desktop-A',
    name: 'Projects',
    private_workspace_id: 'workspace-A',
    workspace_id: null,
    space_id: null,
    is_default: false,
    sort_order: 0,
    deleted_at: null,
    updated_at: SERVER_TIME,
    ...overrides,
  };
}

function remoteNote(overrides: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: 'remote-note',
    client_note_id: 'original-note',
    title: 'Root note in B',
    content: 'Keep in B',
    folder_id: null,
    private_workspace_id: 'workspace-B',
    enhanced_content: null,
    enhancement_prompt: null,
    transcript: null,
    note_type: 'personal',
    source_file: null,
    audio_duration_seconds: null,
    participants: null,
    calendar_event_id: null,
    deleted_at: null,
    updated_at: SERVER_TIME,
    ...overrides,
  };
}

beforeEach((): void => {
  jest.resetAllMocks();
  const { repo, db } = createMemoryRepository();
  mockRepo = repo;
  mockSpaces = new LocalSpacesRepository(
    db as unknown as ConstructorParameters<typeof LocalSpacesRepository>[0],
  );
  mockRepo.setSyncState('team_spaces_capability', 'true');
  mockRepo.setSyncState('private_workspace_placement', 'true');
  mockRepo.setSyncState('private_default_workspace_id', 'workspace-A');
  jest.mocked(batchCreateFolders).mockResolvedValue({ created: [] });
  jest.mocked(batchCreateNotes).mockImplementation(async (items) => ({
    created: items.map((item, index) => ({
      id: `created-note-${index}`,
      client_note_id: item.client_note_id,
      updated_at: SERVER_TIME,
    })),
  }));
  jest.mocked(deleteNote).mockResolvedValue(undefined);
});

it.each(['another client', 'missing client IDs'])(
  'keeps same-named folders and their notes in separate Private workspaces with %s receipts',
  async (receiptKind): Promise<void> => {
    const folderA = mockRepo.createFolder('Projects', undefined, {
      privateWorkspaceId: 'workspace-A',
    });
    const folderB = mockRepo.createFolder('Projects', undefined, {
      privateWorkspaceId: 'workspace-B',
    });
    mockRepo.setFolderClientId(folderA.id, 'mobile-A');
    mockRepo.setFolderClientId(folderB.id, 'mobile-B');
    const noteA = mockRepo.createNote('Note A', 'Keep in A', folderA.id);
    const noteB = mockRepo.createNote('Note B', 'Keep in B', folderB.id);
    mockRepo.setNoteClientId(noteA.id, 'note-A');
    mockRepo.setNoteClientId(noteB.id, 'note-B');
    const receipts = [
      remoteFolder({ client_folder_id: receiptKind === 'another client' ? 'desktop-A' : null }),
      remoteFolder({
        id: 'remote-B',
        private_workspace_id: 'workspace-B',
        client_folder_id: receiptKind === 'another client' ? 'desktop-B' : null,
      }),
    ];
    for (const receipt of receipts) mockRepo.applyRemoteFolder(receipt);
    // Batch replies may be reordered, including replies without client IDs.
    jest.mocked(batchCreateFolders).mockResolvedValue({ created: [...receipts].reverse() });

    await pushFolders();
    await pushNotes();

    expect(mockRepo.getNoteById(noteA.id)?.folderId).toBe(folderA.id);
    expect(mockRepo.getNoteById(noteB.id)?.folderId).toBe(folderB.id);
    expect(batchCreateNotes).toHaveBeenCalledWith([
      expect.objectContaining({ title: 'Note A', folder_id: 'remote-A' }),
      expect.objectContaining({ title: 'Note B', folder_id: 'remote-B' }),
    ]);
  },
);

it.each([
  { localPlacement: null, remotePlacement: 'workspace-A' },
  { localPlacement: 'workspace-A', remotePlacement: null },
])(
  'adopts legacy and explicit default placements as the same Private (%j)',
  async ({ localPlacement, remotePlacement }): Promise<void> => {
    const folder = mockRepo.createFolder('Projects', undefined, {
      privateWorkspaceId: localPlacement,
    });
    mockRepo.setFolderClientId(folder.id, 'mobile-A');
    jest.mocked(batchCreateFolders).mockResolvedValue({
      created: [remoteFolder({ private_workspace_id: remotePlacement })],
    });

    await pushFolders();

    expect(mockRepo.getFolders().find(({ id }) => id === folder.id)).toMatchObject({
      remoteId: 'remote-A',
      pendingSync: 0,
    });
  },
);

it('retains a folderless note’s Private when publishing it after device-only privacy', async (): Promise<void> => {
  const remote = remoteNote();
  mockRepo.applyRemoteNote(remote, () => null);
  const local = mockRepo.getNoteForRemote(remote)!;
  mockRepo.setNotePrivacy(local.id, true);
  await deletePrivateNoteCloudCopy(mockRepo.getNoteById(local.id)!);
  mockRepo.setNotePrivacy(local.id, false);

  await pushNotes();

  expect(batchCreateNotes).toHaveBeenCalledWith([
    expect.objectContaining({ folder_id: null, private_workspace_id: 'workspace-B' }),
  ]);
  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    privateWorkspaceId: 'workspace-B',
    remoteId: 'created-note-0',
    pendingSync: 0,
  });
});

it.each(['unsupported', 'filed', 'team', 'unplaced'])(
  'omits note placement when the create is %s',
  async (kind): Promise<void> => {
    const team = mockSpaces.upsertFromRemote({
      id: 'team-space',
      workspace_id: 'workspace-B',
      name: 'Team',
      my_role: 'admin',
    });
    const folder = remoteFolder({ private_workspace_id: 'workspace-B' });
    mockRepo.applyRemoteFolder(folder);
    const localFolderId = mockRepo.getFolderByRemoteId(folder.id)!.id;
    const remote = remoteNote({
      folder_id: kind === 'filed' ? folder.id : null,
      private_workspace_id: kind === 'unplaced' ? null : 'workspace-B',
    });
    mockRepo.applyRemoteNote(
      remote,
      (remoteId) => (remoteId === folder.id ? localFolderId : null),
      { ...(kind === 'team' ? { spaceId: team.id } : {}) },
    );
    const local = mockRepo.getNoteForRemote(remote)!;
    mockRepo.setNotePrivacy(local.id, false);
    if (kind === 'unsupported') mockRepo.setSyncState('private_workspace_placement', 'false');

    await pushNotes();

    const [payload] = jest.mocked(batchCreateNotes).mock.calls[0][0];
    expect(payload).not.toHaveProperty('private_workspace_id');
    expect(payload.folder_id).toBe(kind === 'filed' ? folder.id : null);
    expect(payload.space_id).toBe(kind === 'team' ? 'team-space' : null);
  },
);
