import { act, cleanup, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { Practice } from '../Practice';
import { usePracticeSession } from '../practiceSession';
import { useBubbleResult } from '../bubbleResult';

const mockTranslate = (key: string) => key;
let mockStatus = { enabled: true, overlay: true, accessibility: true, microphone: true };
let mockStatusListener: () => void;
const mockRemoveStatus = jest.fn();
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockTranslate }) }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('../ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => children,
  styles: {},
  palette: {},
}));
jest.mock('../PermissionsScreen', () => ({
  PermissionsContent: () =>
    require('react').createElement(require('react-native').Text, null, 'Permission setup'),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    getStatus: () => mockStatus,
    setPractice: jest.fn(async () => {}),
  },
  dictationEvents: {
    addListener: (_event: string, listener: () => void) => {
      mockStatusListener = listener;
      return { remove: mockRemoveStatus };
    },
  },
}));

let appStateListener: (state: AppStateStatus) => void;
let originalState: AppStateStatus;
const removeAppState = jest.fn();
function changeAppState(state: AppStateStatus) {
  AppState.currentState = state;
  act(() => appStateListener(state));
}

beforeEach(() => {
  jest.clearAllMocks();
  originalState = AppState.currentState;
  AppState.currentState = 'active';
  mockStatus = { enabled: true, overlay: true, accessibility: true, microphone: true };
  usePracticeSession.setState({ active: false, completedMode: null, revision: 0 });
  useBubbleResult.getState().dismiss();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    appStateListener = listener;
    return { remove: removeAppState };
  });
});
afterEach(() => {
  cleanup();
  AppState.currentState = originalState;
  jest.restoreAllMocks();
});

it('limits native practice visibility to the foreground practice screen and releases it on exit', () => {
  const view = render(<Practice initialMode="edit" />);
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(true, 'edit');
  expect(screen.getByLabelText('messagePlaceholder').props.value).toBe('editSeed');

  changeAppState('background');
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(false, 'dictate');
  expect(usePracticeSession.getState().active).toBe(false);
  changeAppState('active');
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(true, 'edit');

  view.rerender(<Practice initialMode="edit" visible={false} />);
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(false, 'edit');
  changeAppState('background');
  changeAppState('active');
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(false, 'edit');
  expect(usePracticeSession.getState().active).toBe(false);

  view.rerender(<Practice initialMode="edit" />);
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(true, 'edit');
  view.unmount();
  expect(AndroidDictation!.setPractice).toHaveBeenLastCalledWith(false, 'dictate');
  expect(usePracticeSession.getState().active).toBe(false);
  expect(mockRemoveStatus).toHaveBeenCalled();
  expect(removeAppState).toHaveBeenCalled();
});

it('refreshes permission guidance after system settings and permission revocation', () => {
  mockStatus.microphone = false;
  render(<Practice />);
  expect(screen.getByText('Permission setup')).toBeTruthy();
  changeAppState('background');
  mockStatus.microphone = true;
  changeAppState('active');
  expect(screen.queryByText('Permission setup')).toBeNull();
  mockStatus.accessibility = false;
  act(() => mockStatusListener());
  expect(screen.getByText('Permission setup')).toBeTruthy();
});

it('requires a new successful insertion in the requested mode before completing practice', () => {
  usePracticeSession.setState({ completedMode: 'edit', revision: 4 });
  const onSuccess = jest.fn();
  render(<Practice initialMode="edit" onSuccess={onSuccess} />);
  expect(onSuccess).not.toHaveBeenCalled();
  act(() => usePracticeSession.getState().complete('dictate'));
  expect(onSuccess).not.toHaveBeenCalled();
  act(() => useBubbleResult.getState().setResult('retained text', 'Insertion failed'));
  expect(screen.getByRole('alert')).toHaveTextContent('Insertion failed');
  expect(onSuccess).not.toHaveBeenCalled();
  act(() => usePracticeSession.getState().complete('edit'));
  expect(onSuccess).toHaveBeenCalledTimes(1);
  expect(screen.getByText('success')).toBeTruthy();
});

it('ignores insertion completion after practice is hidden or backgrounded', () => {
  const onSuccess = jest.fn();
  const view = render(<Practice onSuccess={onSuccess} />);
  changeAppState('background');
  act(() => usePracticeSession.getState().complete('dictate'));
  changeAppState('active');
  view.rerender(<Practice onSuccess={onSuccess} visible={false} />);
  act(() => usePracticeSession.getState().complete('dictate'));
  expect(onSuccess).not.toHaveBeenCalled();
  expect(screen.queryByText('success')).toBeNull();
});
