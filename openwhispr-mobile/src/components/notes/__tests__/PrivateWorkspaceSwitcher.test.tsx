import { fireEvent, render } from '@testing-library/react-native';
import { PrivateWorkspaceSwitcher } from '../PrivateWorkspaceSwitcher';

jest.mock('@react-native-menu/menu', () => require('./menuViewMock'));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const WORKSPACES = [
  { id: 'own', name: 'Mine', is_default: true },
  { id: 'acme', name: 'Acme' },
];

describe('PrivateWorkspaceSwitcher', () => {
  it('renders nothing for a single workspace', () => {
    const { toJSON } = render(
      <PrivateWorkspaceSwitcher
        defaultId="own"
        workspaces={[WORKSPACES[0]]}
        activeId="own"
        onSelect={jest.fn()}
      />,
    );
    expect(toJSON()).toBeNull();
  });

  it('names the active workspace and checks it in the menu', () => {
    const { getByLabelText, getByTestId } = render(
      <PrivateWorkspaceSwitcher
        defaultId="own"
        workspaces={WORKSPACES}
        activeId="acme"
        onSelect={jest.fn()}
      />,
    );
    expect(getByLabelText('Workspace: Acme')).toBeTruthy();
    expect(getByTestId('menu-acme').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('menu-own').props.accessibilityState.selected).toBe(false);
  });

  it('switches to another workspace, and ignores a pick of the active one', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <PrivateWorkspaceSwitcher
        defaultId="own"
        workspaces={WORKSPACES}
        activeId="own"
        onSelect={onSelect}
      />,
    );
    fireEvent.press(getByTestId('menu-own'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.press(getByTestId('menu-acme'));
    expect(onSelect).toHaveBeenCalledWith('acme');
  });

  it('shows the first workspace when the active one isn’t listed', () => {
    const { getByLabelText } = render(
      <PrivateWorkspaceSwitcher
        defaultId="own"
        workspaces={WORKSPACES}
        activeId="gone"
        onSelect={jest.fn()}
      />,
    );
    expect(getByLabelText('Workspace: Mine')).toBeTruthy();
  });
});
