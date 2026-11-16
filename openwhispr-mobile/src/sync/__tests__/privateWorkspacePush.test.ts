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
  fetchNotes: jest.fn(),
  updateNote: jest.fn(),
}));

import {
  batchCreateFolders,
  batchCreateNotes,
  deleteNote,
  fetchNotes,
  updateNote,
  type NoteCreateResponse,
} from '@/data/remote/notesApi';
import { deletePrivateNoteCloudCopy } from '../privateNoteDeletion';
import { pushFolders } from '../pushFolders';
import { pushNotes } from '../pushNotes';
import { pullNotesTeam } from '../pullNotesTeam';

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

function refusePrivateWorkspaceOnce(): void {
  jest.mocked(batchCreateNotes).mockImplementationOnce(
    async (items): Promise<NoteCreateResponse> => ({
      created: [],
      refused: items.map((item): { client_note_id: string; code: string } => ({
        client_note_id: item.client_note_id,
        code: 'private_workspace_not_found',
      })),
    }),
  );
}

it('uploads recovered team edits after the API refuses their former Private workspace', async (): Promise<void> => {
  const team = mockSpaces.upsertFromRemote({
    id: 'team-B',
    workspace_id: 'workspace-B',
    name: 'B team',
    my_role: 'admin',
  });
  const remote = remoteNote();
  mockRepo.applyRemoteNote(remote, () => null);
  const local = mockRepo.getNoteForRemote(remote)!;
  mockRepo.moveNoteToSpace(local.id, team.id);
  jest.mocked(updateNote).mockResolvedValue({
    ...remote,
    private_workspace_id: null,
    workspace_id: 'workspace-B',
    space_id: 'team-B',
  });
  await pushNotes();

  mockRepo.updateNote(local.id, { content: 'Offline team edit' });
  mockSpaces.softDeleteByCloudId('team-B');
  jest.mocked(fetchNotes).mockResolvedValue({
    notes: [{ ...remote, access_removed: true, space_id: 'team-B' }],
    hasMore: false,
  });
  await pullNotesTeam();
  const recoveredClientId = mockRepo.getNoteById(local.id)!.clientNoteId;
  refusePrivateWorkspaceOnce();

  await pushNotes();

  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    content: 'Offline team edit',
    privateWorkspaceId: null,
    clientNoteId: recoveredClientId,
    remoteId: null,
    pendingSync: 1,
  });
  await pushNotes();
  expect(jest.mocked(batchCreateNotes).mock.calls[1][0][0]).not.toHaveProperty(
    'private_workspace_id',
  );
  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    privateWorkspaceId: null,
    clientNoteId: recoveredClientId,
    remoteId: 'created-note-0',
    pendingSync: 0,
  });
  await pushNotes();
  expect(batchCreateNotes).toHaveBeenCalledTimes(2);
});

it('republishes a folderless device-only note in the default after a placement refusal', async (): Promise<void> => {
  const remote = remoteNote();
  mockRepo.applyRemoteNote(remote, () => null);
  const local = mockRepo.getNoteForRemote(remote)!;
  mockRepo.setNotePrivacy(local.id, true);
  await deletePrivateNoteCloudCopy(mockRepo.getNoteById(local.id)!);
  mockRepo.setNotePrivacy(local.id, false);
  const publishedClientId = mockRepo.getNoteById(local.id)!.clientNoteId;
  // Cached membership may still list B; only the write refusal proves it cannot be used.
  mockRepo.setSyncState('private_workspaces', JSON.stringify([{ id: 'workspace-B', name: 'B' }]));
  refusePrivateWorkspaceOnce();

  await pushNotes();
  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    privateWorkspaceId: null,
    clientNoteId: publishedClientId,
    pendingSync: 1,
  });
  await pushNotes();

  expect(jest.mocked(batchCreateNotes).mock.calls[1][0][0]).toMatchObject({
    client_note_id: publishedClientId,
    folder_id: null,
    space_id: null,
  });
  expect(jest.mocked(batchCreateNotes).mock.calls[1][0][0]).not.toHaveProperty(
    'private_workspace_id',
  );
  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    privateWorkspaceId: null,
    clientNoteId: publishedClientId,
    remoteId: 'created-note-0',
    pendingSync: 0,
  });
});

it.each(['private', 'folder', 'team', 'republished'])(
  'does not apply a stale placement refusal after the note becomes %s in flight',
  async (change): Promise<void> => {
    const remote = remoteNote();
    mockRepo.applyRemoteNote(remote, () => null);
    const local = mockRepo.getNoteForRemote(remote)!;
    mockRepo.setNotePrivacy(local.id, false);
    jest
      .mocked(batchCreateNotes)
      .mockImplementationOnce(async (items): Promise<NoteCreateResponse> => {
        if (change === 'private') mockRepo.setNotePrivacy(local.id, true);
        if (change === 'republished') mockRepo.setNotePrivacy(local.id, false);
        if (change === 'folder') {
          const folder = mockRepo.createFolder('New destination');
          mockRepo.moveNoteToFolder(local.id, folder.id);
        }
        if (change === 'team') {
          const team = mockSpaces.upsertFromRemote({
            id: 'team-C',
            workspace_id: 'workspace-C',
            name: 'C team',
            my_role: 'admin',
          });
          mockRepo.moveNoteToSpace(local.id, team.id);
        }
        return {
          created: [],
          refused: [
            { client_note_id: items[0].client_note_id, code: 'private_workspace_not_found' },
          ],
        };
      });

    await pushNotes();

    expect(mockRepo.getNoteById(local.id)?.privateWorkspaceId).toBe('workspace-B');
  },
);

it('preserves an edit made while the rejected placement create was in flight', async (): Promise<void> => {
  const remote = remoteNote();
  mockRepo.applyRemoteNote(remote, () => null);
  const local = mockRepo.getNoteForRemote(remote)!;
  mockRepo.setNotePrivacy(local.id, false);
  jest
    .mocked(batchCreateNotes)
    .mockImplementationOnce(async (items): Promise<NoteCreateResponse> => {
      mockRepo.updateNote(local.id, { content: 'Newer edit' });
      return {
        created: [],
        refused: [{ client_note_id: items[0].client_note_id, code: 'private_workspace_not_found' }],
      };
    });

  await pushNotes();

  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    privateWorkspaceId: null,
    content: 'Newer edit',
    pendingSync: 1,
  });
  await pushNotes();
  expect(mockRepo.getNoteById(local.id)).toMatchObject({
    content: 'Newer edit',
    remoteId: 'created-note-0',
    pendingSync: 0,
  });
});

it('recovers only the refused placement row in a mixed create response', async (): Promise<void> => {
  const localIds = ['accepted', 'lost', 'other-refusal'].map((identity): number => {
    const remote = remoteNote({ id: identity, client_note_id: identity });
    mockRepo.applyRemoteNote(remote, () => null);
    const local = mockRepo.getNoteForRemote(remote)!;
    mockRepo.setNotePrivacy(local.id, false);
    return local.id;
  });
  jest.mocked(batchCreateNotes).mockImplementationOnce(
    async (items): Promise<NoteCreateResponse> => ({
      created: [
        { id: 'accepted-cloud', client_note_id: items[0].client_note_id, updated_at: SERVER_TIME },
      ],
      refused: [
        // A matching acknowledgment wins even if a backend also labels that input refused.
        { client_note_id: items[0].client_note_id, code: 'private_workspace_not_found' },
        { client_note_id: items[1].client_note_id, code: 'private_workspace_not_found' },
        { client_note_id: items[2].client_note_id, code: 'note_scope_change_denied' },
      ],
    }),
  );

  await pushNotes();

  expect(mockRepo.getNoteById(localIds[0])).toMatchObject({
    privateWorkspaceId: 'workspace-B',
    remoteId: 'accepted-cloud',
    pendingSync: 0,
  });
  expect(mockRepo.getNoteById(localIds[1])).toMatchObject({
    privateWorkspaceId: null,
    remoteId: null,
    pendingSync: 1,
  });
  expect(mockRepo.getNoteById(localIds[2])).toMatchObject({
    privateWorkspaceId: 'workspace-B',
    remoteId: null,
    pendingSync: 1,
  });
});
