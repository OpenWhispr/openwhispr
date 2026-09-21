import { fireEvent, render } from '@testing-library/react-native';
import type { Space } from '@/data';
import { SpaceRow } from '../SpaceRow';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const space = (overrides: Partial<Space> = {}): Space =>
  ({
    id: 1,
    clientSpaceId: 'client-space-1',
    cloudSpaceId: 'cloud-space-1',
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

describe('SpaceRow', () => {
  it('renders the emoji, name, and pluralized member count', () => {
    const { getByText } = render(<SpaceRow space={space()} onPress={jest.fn()} />);

    expect(getByText('🛠️')).toBeTruthy();
    expect(getByText('Engineering')).toBeTruthy();
    expect(getByText('3 members')).toBeTruthy();
  });

  it('uses the singular "member" for a count of exactly one', () => {
    const { getByText } = render(
      <SpaceRow space={space({ memberCount: 1 })} onPress={jest.fn()} />,
    );

    expect(getByText('1 member')).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByLabelText } = render(<SpaceRow space={space()} onPress={onPress} />);

    fireEvent.press(getByLabelText('Engineering, 3 members'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
