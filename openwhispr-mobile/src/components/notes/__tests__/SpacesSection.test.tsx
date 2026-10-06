import { fireEvent, render } from '@testing-library/react-native';
import type { Space } from '@/data';
import { SpacesSection } from '../SpacesSection';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
// The real SectionHeader uses react-native-reanimated (no jest mock configured for it in this
// project — see other tests that stub SectionHeader out entirely). Render its label as plain
// text instead of stubbing to null, so this test can still assert the section title.
jest.mock('../SectionHeader', () => ({
  SectionHeader: ({ label }: { label: string }) =>
    require('react').createElement(require('react-native').Text, null, label),
}));

const space = (overrides: Partial<Space> = {}): Space =>
  ({
    id: 1,
    clientSpaceId: 'client-space-1',
    cloudSpaceId: 'cloud-space-1',
    workspaceId: 'workspace-1',
    workspaceName: null,
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

describe('SpacesSection', () => {
  it('renders nothing when there are no team spaces — zero visual change for personal-only users', () => {
    const { toJSON } = render(<SpacesSection spaces={[]} onSelect={jest.fn()} />);

    expect(toJSON()).toBeNull();
  });

  it('renders a "Spaces" section listing each team space when at least one exists', () => {
    const { getByText } = render(
      <SpacesSection
        spaces={[space(), space({ id: 2, name: 'Design', memberCount: 5 })]}
        onSelect={jest.fn()}
      />,
    );

    expect(getByText('Spaces')).toBeTruthy();
    expect(getByText('Engineering')).toBeTruthy();
    expect(getByText('Design')).toBeTruthy();
  });

  it('separates spaces from different workspaces under their workspace names', () => {
    const { getByText } = render(
      <SpacesSection
        spaces={[
          space({ id: 1, name: 'Engineering', workspaceId: 'w1', workspaceName: 'Acme' }),
          space({ id: 2, name: 'Design', workspaceId: 'w2', workspaceName: 'Globex' }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    expect(getByText('Acme')).toBeTruthy();
    expect(getByText('Globex')).toBeTruthy();
    expect(getByText('Engineering')).toBeTruthy();
    expect(getByText('Design')).toBeTruthy();
  });

  it('groups spaces sharing a workspace under a single heading', () => {
    const { getAllByText } = render(
      <SpacesSection
        spaces={[
          space({ id: 1, name: 'Engineering', workspaceId: 'w1', workspaceName: 'Acme' }),
          space({ id: 2, name: 'Design', workspaceId: 'w1', workspaceName: 'Acme' }),
        ]}
        onSelect={jest.fn()}
      />,
    );

    expect(getAllByText('Acme')).toHaveLength(1);
  });

  it('falls back to a plain "Spaces" heading when the workspace name has not synced yet', () => {
    const { getByText } = render(
      <SpacesSection spaces={[space({ workspaceName: null })]} onSelect={jest.fn()} />,
    );

    expect(getByText('Spaces')).toBeTruthy();
  });

  it('calls onSelect with the tapped space id', () => {
    const onSelect = jest.fn();
    const { getByLabelText } = render(<SpacesSection spaces={[space()]} onSelect={onSelect} />);

    fireEvent.press(getByLabelText('Engineering, 3 members'));

    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
