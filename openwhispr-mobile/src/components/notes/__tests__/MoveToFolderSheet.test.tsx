import { fireEvent, render } from '@testing-library/react-native';
import type { Folder, Space } from '@/data';
import { MoveToFolderSheet } from '../MoveToFolderSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => {
    const { Pressable } = require('react-native');
    return (
      <Pressable accessibilityLabel={accessibilityLabel} onPress={onPress}>
        {children}
      </Pressable>
    );
  },
}));

const folder = (overrides: Partial<Folder> = {}): Folder =>
  ({
    id: 1,
    name: 'Ideas',
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

const space = (overrides: Partial<Space> = {}): Space =>
  ({
    id: 2,
    clientSpaceId: 'client-space-2',
    cloudSpaceId: 'cloud-space-2',
    workspaceId: 'workspace-1',
    kind: 'team',
    name: 'Engineering',
    emoji: '🛠️',
    sortOrder: 0,
    myRole: 'member',
    memberCount: 3,
    teams: null,
    syncStatus: 'synced',
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Space;

describe('MoveToFolderSheet — personal-only (no team spaces): unchanged from before spaces existed', () => {
  it('renders only the folder picker, with no Spaces section at all', () => {
    const { getByText, queryByText, getByLabelText, queryByLabelText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder()]}
        folderCounts={{ 1: 2 }}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
      />,
    );

    expect(getByText('Move to Folder')).toBeTruthy();
    expect(getByLabelText('Create new folder')).toBeTruthy();
    expect(getByText('Ideas')).toBeTruthy();
    expect(queryByText('Spaces')).toBeNull();
    expect(queryByLabelText('Move to Private space')).toBeNull();
  });

  it('picking a folder calls onPickFolder', () => {
    const onPickFolder = jest.fn();
    const { getByText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder({ id: 5, name: 'Ideas' })]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={onPickFolder}
        onCreateAndPick={jest.fn()}
      />,
    );

    fireEvent.press(getByText('Ideas'));

    expect(onPickFolder).toHaveBeenCalledWith(5);
  });
});

describe('MoveToFolderSheet — browsing folders/All Notes with team spaces present', () => {
  it('shows the folder picker plus a Spaces section', () => {
    const { getByText, queryByLabelText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder()]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
        spaces={[space()]}
        activeSpaceId={null}
        onPickSpace={jest.fn()}
      />,
    );

    expect(getByText('Ideas')).toBeTruthy();
    expect(getByText('Spaces')).toBeTruthy();
    expect(getByText('Engineering')).toBeTruthy();
    expect(queryByLabelText('Move to Private space')).toBeNull();
  });

  it('picking a space calls onPickSpace with its id', () => {
    const onPickSpace = jest.fn();
    const { getByText } = render(
      <MoveToFolderSheet
        visible
        folders={[]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
        spaces={[space({ id: 2, name: 'Engineering' })]}
        activeSpaceId={null}
        onPickSpace={onPickSpace}
      />,
    );

    fireEvent.press(getByText('Engineering'));

    expect(onPickSpace).toHaveBeenCalledWith(2);
  });
});

describe('MoveToFolderSheet — browsing inside a team space', () => {
  // The caller passes the browsed space's folders here, never the private space's
  // (see NotesListScreen's moveTargetFolders), so the picker stays in-scope.
  it('offers the space folders it was given alongside the spaces the note may move to', () => {
    const { getByText, getByLabelText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder({ id: 7, name: 'Specs' })]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
        spaces={[space({ id: 3, name: 'Design' })]}
        activeSpaceId={2}
        onPickSpace={jest.fn()}
      />,
    );

    expect(getByText('Move Note')).toBeTruthy();
    expect(getByLabelText('Create new folder')).toBeTruthy();
    expect(getByText('Specs')).toBeTruthy();
    expect(getByText('Design')).toBeTruthy();
  });

  it('picking one of the space folders moves the note within the space', () => {
    const onPickFolder = jest.fn();
    const { getByLabelText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder({ id: 7, name: 'Specs' })]}
        folderCounts={{ 7: 4 }}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={onPickFolder}
        onCreateAndPick={jest.fn()}
        spaces={[]}
        activeSpaceId={2}
        onPickSpace={jest.fn()}
      />,
    );

    fireEvent.press(getByLabelText('Specs, 4 notes'));

    expect(onPickFolder).toHaveBeenCalledWith(7);
  });

  // Matches desktop's canMoveBetweenSpaces: team content never returns to the
  // private space, so the sheet offers no route back out of a space.
  it('never offers a way back to the private space', () => {
    const { queryByLabelText, queryByText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder({ id: 7, name: 'Specs' })]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
        spaces={[space({ id: 3, name: 'Design' })]}
        activeSpaceId={2}
        onPickSpace={jest.fn()}
      />,
    );

    expect(queryByLabelText('Move to Private space')).toBeNull();
    expect(queryByText('Move to Personal')).toBeNull();
  });

  it('renders no Spaces section when the note has nowhere it may move to', () => {
    const { queryByText } = render(
      <MoveToFolderSheet
        visible
        folders={[folder({ id: 7, name: 'Specs' })]}
        folderCounts={{}}
        excludeFolderId={null}
        onClose={jest.fn()}
        onPickFolder={jest.fn()}
        onCreateAndPick={jest.fn()}
        spaces={[]}
        activeSpaceId={2}
        onPickSpace={jest.fn()}
      />,
    );

    expect(queryByText('Spaces')).toBeNull();
  });
});
