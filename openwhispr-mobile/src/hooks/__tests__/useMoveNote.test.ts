import { act, renderHook } from '@testing-library/react-native';
import type { Folder, Space } from '@/data';
import { useMoveNote } from '@/hooks/useMoveNote';

const mockState = {
  spaces: [] as Space[],
  folderCounts: { 1: 4 } as Record<number, number>,
  moveNoteToFolder: jest.fn(),
  moveNoteToSpace: jest.fn(),
  createFolder: jest.fn(),
};

jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const space = (overrides: Partial<Space>): Space =>
  ({
    id: 1,
    clientSpaceId: 'client',
    cloudSpaceId: 'cloud',
    workspaceId: null,
    kind: 'private',
    name: 'Personal',
    emoji: null,
    sortOrder: 0,
    myRole: null,
    memberCount: 1,
    teams: null,
    syncStatus: 'synced',
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Space;

const folder = (overrides: Partial<Folder>): Folder =>
  ({
    id: 1,
    name: 'Meetings',
    isDefault: 0,
    sortOrder: 0,
    spaceId: 1,
    clientFolderId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Folder;

const privateSpace = space({ id: 1, kind: 'private' });
const engineering = space({ id: 2, kind: 'team', workspaceId: 'w1', name: 'Engineering' });
const design = space({ id: 3, kind: 'team', workspaceId: 'w1', name: 'Design' });
const otherWorkspace = space({ id: 4, kind: 'team', workspaceId: 'w2', name: 'Elsewhere' });

beforeEach(() => {
  jest.clearAllMocks();
  mockState.spaces = [privateSpace, engineering, design, otherWorkspace];
});

describe('useMoveNote', () => {
  it('starts closed and passes the folders and counts through', () => {
    const folders = [folder({ id: 1 })];
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: folders, excludeFolderId: 1 }),
    );
    expect(result.current.sheetProps).toEqual(
      expect.objectContaining({
        visible: false,
        folders,
        folderCounts: { 1: 4 },
        excludeFolderId: 1,
        activeSpaceId: null,
      }),
    );
  });

  it('offers personal content every team space, never the private one', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: [], excludeFolderId: null }),
    );
    expect(result.current.sheetProps.spaces?.map((s) => s.id)).toEqual([2, 3, 4]);
  });

  it('keeps team content inside its own workspace', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: 2, targetFolders: [], excludeFolderId: null }),
    );
    expect(result.current.sheetProps.spaces?.map((s) => s.id)).toEqual([3]);
  });

  it('moves the opened note into the picked folder and closes', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: [], excludeFolderId: null }),
    );
    act(() => result.current.open(7));
    expect(result.current.sheetProps.visible).toBe(true);
    act(() => result.current.sheetProps.onPickFolder(5));
    expect(mockState.moveNoteToFolder).toHaveBeenCalledWith(7, 5);
    expect(result.current.sheetProps.visible).toBe(false);
  });

  it('closes without moving when the caller closes it', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: [], excludeFolderId: null }),
    );
    act(() => result.current.open(7));
    act(() => result.current.close());
    expect(result.current.sheetProps.visible).toBe(false);
    act(() => result.current.sheetProps.onPickFolder(5));
    expect(mockState.moveNoteToFolder).not.toHaveBeenCalled();
  });

  it('creates the new folder in the note’s space and moves the note into it', () => {
    mockState.createFolder.mockReturnValue(folder({ id: 9, spaceId: 2 }));
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: 2, targetFolders: [], excludeFolderId: null }),
    );
    act(() => result.current.open(7));
    act(() => result.current.sheetProps.onCreateAndPick('Launch'));
    expect(mockState.createFolder).toHaveBeenCalledWith('Launch', 2);
    expect(mockState.moveNoteToFolder).toHaveBeenCalledWith(7, 9);
  });

  it('moves the opened note to the picked space', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: [], excludeFolderId: null }),
    );
    act(() => result.current.open(7));
    act(() => result.current.sheetProps.onPickSpace?.(3));
    expect(mockState.moveNoteToSpace).toHaveBeenCalledWith(7, 3);
    expect(result.current.sheetProps.visible).toBe(false);
  });

  it('does nothing when a pick arrives with no note open', () => {
    const { result } = renderHook(() =>
      useMoveNote({ scopeSpaceId: null, targetFolders: [], excludeFolderId: null }),
    );
    act(() => result.current.sheetProps.onPickFolder(5));
    expect(mockState.moveNoteToFolder).not.toHaveBeenCalled();
  });
});
