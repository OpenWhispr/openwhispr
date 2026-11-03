import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { NoteRecordingControls } from '../NoteRecordingControls';

let mockGuard: ((event: { data: { action: { type: string } } }) => void) | undefined;
let mockPrevented = false;
const mockDispatch = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: mockDispatch }),
  usePreventRemove: (enabled: boolean, callback: typeof mockGuard) => {
    mockPrevented = enabled;
    mockGuard = callback;
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 12 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../ui', () => ({
  palette: {},
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <Pressable disabled={disabled} onPress={onPress}>
        <Text>{label}</Text>
      </Pressable>
    );
  },
}));
const props = () => ({
  isStarting: false,
  isRecording: false,
  isProcessing: false,
  disabled: false,
  keyboardVisible: false,
  onStart: jest.fn(async () => {}),
  onStop: jest.fn(async (): Promise<boolean | undefined> => true),
  onDiscard: jest.fn(async () => {}),
  onFlush: jest.fn(),
});
const action = { type: 'GO_BACK' };
let alert: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

it('starts only after an explicit press', async () => {
  const p = props();
  render(<NoteRecordingControls {...p} />);
  expect(p.onStart).not.toHaveBeenCalled();
  expect(mockPrevented).toBe(false);
  await act(async () => fireEvent.press(screen.getByText('noteStart')));
  expect(p.onStart).toHaveBeenCalledTimes(1);
});
it('finishes and flushes the note before navigating', async () => {
  const p = { ...props(), isRecording: true };
  const view = render(<NoteRecordingControls {...p} />);
  act(() => mockGuard!({ data: { action } }));
  await act(async () => alert.mock.calls[0][2][2].onPress());
  expect(mockDispatch).not.toHaveBeenCalled();
  view.rerender(<NoteRecordingControls {...p} isRecording={false} />);
  await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(action));
  expect(p.onFlush.mock.invocationCallOrder[0]).toBeLessThan(
    mockDispatch.mock.invocationCallOrder[0],
  );
});
it('keeps the editor open when stopping needs model/quota recovery', async () => {
  const p = { ...props(), isRecording: true };
  p.onStop.mockResolvedValue(undefined);
  const view = render(<NoteRecordingControls {...p} />);
  act(() => mockGuard!({ data: { action } }));
  await act(async () => alert.mock.calls[0][2][2].onPress());
  view.rerender(<NoteRecordingControls {...p} isRecording={false} />);
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('discards only after confirmation and waits for capture to stop', async () => {
  const p = { ...props(), isRecording: true };
  const view = render(<NoteRecordingControls {...p} />);
  act(() => mockGuard!({ data: { action } }));
  expect(p.onDiscard).not.toHaveBeenCalled();
  await act(async () => alert.mock.calls[0][2][1].onPress());
  expect(p.onDiscard).toHaveBeenCalledTimes(1);
  expect(mockDispatch).not.toHaveBeenCalled();
  view.rerender(<NoteRecordingControls {...p} isRecording={false} />);
  await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(action));
});
it.each(['isStarting', 'isProcessing'] as const)(
  'blocks leaving during %s without a destructive option',
  (key) => {
    render(<NoteRecordingControls {...props()} {...{ [key]: true }} />);
    act(() => mockGuard!({ data: { action } }));
    expect(alert).toHaveBeenCalledWith('noteFinishingTitle', 'noteFinishingBody');
    expect(mockDispatch).not.toHaveBeenCalled();
  },
);
