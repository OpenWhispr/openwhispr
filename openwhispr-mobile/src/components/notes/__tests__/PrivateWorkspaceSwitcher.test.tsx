import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { PrivateWorkspaceSwitcher } from '../PrivateWorkspaceSwitcher';

jest.mock('@react-native-menu/menu', () => require('./menuViewMock'));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const WORKSPACES = [
  { id: 'own', name: 'Mine', is_default: true },
  { id: 'acme', name: 'Acme' },
];

const mockNotesState = {
  privateWorkspaces: WORKSPACES,
  defaultPrivateWorkspaceId: 'own',
  activePrivateWorkspaceId: 'own',
  setActivePrivateWorkspace: jest.fn(),
  isInitialized: true,
  initialize: jest.fn(),
};
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (select: (state: typeof mockNotesState) => unknown) => select(mockNotesState),
}));

describe('PrivateWorkspaceSwitcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNotesState.privateWorkspaces = WORKSPACES;
    mockNotesState.activePrivateWorkspaceId = 'own';
  });

  it('keeps the Folders heading and omits the Account row for a single workspace', () => {
    mockNotesState.privateWorkspaces = [WORKSPACES[0]];
    const { toJSON, rerender, getByText, queryByRole } = render(<PrivateWorkspaceSwitcher />);
    expect(toJSON()).toBeNull();
    rerender(<PrivateWorkspaceSwitcher heading={<Text>Folders</Text>} />);
    expect(getByText('Folders')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });

  it('names the active workspace and checks it in the menu', () => {
    mockNotesState.activePrivateWorkspaceId = 'acme';
    const { getByLabelText, getByTestId } = render(<PrivateWorkspaceSwitcher />);
    expect(getByLabelText('Workspace: Acme')).toBeTruthy();
    expect(getByTestId('menu-acme').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('menu-own').props.accessibilityState.selected).toBe(false);
  });

  it('switches to another workspace, and ignores a pick of the active one', () => {
    const onSelect = mockNotesState.setActivePrivateWorkspace;
    const { getByTestId } = render(<PrivateWorkspaceSwitcher />);
    fireEvent.press(getByTestId('menu-own'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.press(getByTestId('menu-acme'));
    expect(onSelect).toHaveBeenCalledWith('acme');
  });

  it('shows the first workspace when the active one isn’t listed', () => {
    mockNotesState.activePrivateWorkspaceId = 'gone';
    const { getByLabelText } = render(<PrivateWorkspaceSwitcher />);
    expect(getByLabelText('Workspace: Mine')).toBeTruthy();
  });
});
