import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';

let mockInset = 0;
let mockFocus: (() => (() => void) | void) | null = null;
const mockSetColor = jest.fn();
let mockNative: ((state: object) => void) | null = null;
const mockGet = jest.fn(async () => ({ known: true, buttons: false, bottom: 0 }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockInset }),
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | void) => {
    mockFocus = effect;
  },
}));
jest.mock('../../../modules/android-dictation/src/navigationBar', () => ({
  getNavigationBar: () => mockGet(),
  setNavigationBarColor: (color: number | null) => mockSetColor(color),
  navigationBarEvents: {
    addListener: (_name: string, listener: (state: object) => void) => {
      mockNative = listener;
    },
  },
}));

import { useNavigationBar, useNavigationBarCanvas } from '../navigationBar';

function Probe() {
  const { buttons, inset } = useNavigationBar();
  return <Text>{`${buttons ? 'buttons' : 'gestures'} ${inset}`}</Text>;
}

it('reads gestures or buttons from Android and follows a live switch', async () => {
  mockInset = 48;
  const view = render(<Probe />);
  // Native says gestures although the inset is tall: the tappable inset wins.
  await act(async () => {});
  expect(view.getByText('gestures 48')).toBeTruthy();
  act(() => mockNative!({ known: true, buttons: true, bottom: 48 }));
  expect(view.getByText('buttons 48')).toBeTruthy();
});

it('paints the button bar while a Settings screen is focused, and hands it back after', () => {
  function Screen() {
    useNavigationBarCanvas('#F8F6F5');
    return null;
  }
  // The first test left Android reporting buttons.
  render(<Screen />);
  let cleanup: (() => void) | void;
  act(() => {
    cleanup = mockFocus!();
  });
  expect(mockSetColor).toHaveBeenLastCalledWith(0xfff8f6f5 | 0);
  act(() => cleanup!());
  expect(mockSetColor).toHaveBeenLastCalledWith(null);
});
