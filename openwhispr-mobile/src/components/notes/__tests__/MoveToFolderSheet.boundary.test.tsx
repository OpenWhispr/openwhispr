import { act, cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import { Alert, Modal } from 'react-native';

jest.mock('react-i18next', () => {
  throw new Error('Android translation runtime reached the default move sheet');
});
jest.mock('@/hooks/useAndroidCopy', () => {
  throw new Error('Android copy hook reached the default move sheet');
});
jest.mock('@/components/ui/Button', () => {
  throw new Error('Android inline creation reached the default move sheet');
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: require('react-native').Pressable,
}));
jest.mock('../FolderRow', () => ({ FolderRow: () => null }));
jest.mock('../SpaceRow', () => ({ SpaceRow: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const props = () => ({
  visible: true,
  folders: [],
  folderCounts: {},
  excludeFolderId: null,
  onClose: jest.fn(),
  onPickFolder: jest.fn(),
  onCreateAndPick: jest.fn(),
});

afterEach(async () => {
  await cleanupAsync();
  jest.restoreAllMocks();
});

it('renders the default move sheet without Android translation or inline-creation dependencies', () => {
  const { MoveToFolderSheet } = jest.requireActual('../MoveToFolderSheet');
  const screen = render(<MoveToFolderSheet {...props()} />);
  expect(screen.getByText('Move to Folder')).toBeTruthy();
  expect(screen.getByLabelText('Create new folder')).toBeTruthy();
});

it('keeps the default prompt, rejects empty names and passes the trimmed name to its caller', () => {
  const { MoveToFolderSheet } = jest.requireActual('../MoveToFolderSheet');
  const input = props();
  let submit: ((value?: string) => void) | undefined;
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation((_title, _message, callback) => {
    submit = callback as (value?: string) => void;
  });
  const screen = render(<MoveToFolderSheet {...input} />);
  fireEvent.press(screen.getByLabelText('Create new folder'));
  expect(prompt).toHaveBeenCalledWith(
    'New Folder',
    'Enter a name for the new folder',
    expect.any(Function),
  );
  act(() => {
    submit?.();
    submit?.('  ');
  });
  expect(input.onCreateAndPick).not.toHaveBeenCalled();
  act(() => submit?.('  Literal & folder  '));
  expect(input.onCreateAndPick).toHaveBeenCalledWith('Literal & folder');
  expect(input.onClose).not.toHaveBeenCalled();
});

it('passes the default close callback directly to the modal across visibility changes', () => {
  const { MoveToFolderSheet } = jest.requireActual('../MoveToFolderSheet');
  const input = props();
  const screen = render(<MoveToFolderSheet {...input} />);
  expect(screen.UNSAFE_getByType(Modal).props.onRequestClose).toBe(input.onClose);
  screen.rerender(<MoveToFolderSheet {...input} visible={false} />);
  screen.rerender(<MoveToFolderSheet {...input} />);
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(input.onClose).toHaveBeenCalledTimes(1);
});
