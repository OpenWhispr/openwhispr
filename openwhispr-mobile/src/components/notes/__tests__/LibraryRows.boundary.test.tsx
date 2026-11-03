import { cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { Note, Space } from '@/data';

jest.mock('@/hooks/useAndroidCopy', () => {
  throw new Error('Android copy reached a default library row');
});
jest.mock('react-i18next', () => {
  throw new Error('Android translation reached a default library row');
});
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/SwipeableCard', () => ({
  SwipeableCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('lucide-react-native', () => ({ CloudOff: () => null }));
jest.mock('../SectionHeader', () => ({
  SectionHeader: ({ label }: { label: string }) =>
    require('react').createElement(require('react-native').Text, null, label),
}));

afterEach(async () => {
  await cleanupAsync();
});

it('renders and opens a default folder without Android translation', () => {
  const { FolderRow } = jest.requireActual('../FolderRow');
  const open = jest.fn();
  const screen = render(
    <FolderRow sfName="folder" mdName="Folder" label="My folder" count={2} onPress={open} />,
  );
  fireEvent.press(screen.getByLabelText('My folder, 2 notes'));
  expect(open).toHaveBeenCalledTimes(1);
});

it('renders the default space name and count without Android translation', () => {
  const { SpaceRow } = jest.requireActual('../SpaceRow');
  const open = jest.fn();
  const space = { id: 7, name: 'Research', memberCount: 1 } as Space;
  const screen = render(<SpaceRow space={space} onPress={open} />);
  fireEvent.press(screen.getByLabelText('Research, 1 member'));
  expect(open).toHaveBeenCalledTimes(1);
});

it('keeps the default note fallbacks without Android translation or custom actions', () => {
  const { NoteRow } = jest.requireActual('../NoteRow');
  const note = { id: 4, title: '', content: '', updatedAt: '2026-11-02T12:00:00Z' } as Note;
  const screen = render(
    <NoteRow note={note} bucket="yesterday" onPress={jest.fn()} onDelete={jest.fn()} />,
  );
  const row = screen.getByRole('button', {
    name: 'Untitled, Yesterday, No additional text',
  });
  expect(row.props.accessibilityActions).toBeUndefined();
  expect(row.props.onAccessibilityAction).toBeUndefined();
});

it('keeps default workspace fallback grouping and IDs without Android translation', () => {
  const { SpacesSection } = jest.requireActual('../SpacesSection');
  const select = jest.fn();
  const spaces = [{ id: 7, name: 'Research', memberCount: 1, workspaceName: null }] as Space[];
  const screen = render(<SpacesSection spaces={spaces} onSelect={select} />);
  expect(screen.getByText('Spaces')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Research, 1 member'));
  expect(select).toHaveBeenCalledWith(7);
});

it('does not forward Android custom actions from the default grouped row', () => {
  const { GroupedList } = jest.requireActual('../GroupedList');
  const screen = render(
    <GroupedList>
      <GroupedList.Row
        onPress={jest.fn()}
        accessibilityRole="button"
        accessibilityActions={[{ name: 'delete', label: 'Delete' }]}
        onAccessibilityAction={jest.fn()}
      >
        <Text>Literal row</Text>
      </GroupedList.Row>
    </GroupedList>,
  );
  expect(screen.getByRole('button').props.accessibilityActions).toBeUndefined();
  expect(screen.getByRole('button').props.onAccessibilityAction).toBeUndefined();
});
