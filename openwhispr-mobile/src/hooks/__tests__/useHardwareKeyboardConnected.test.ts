import { act, renderHook } from '@testing-library/react-native';

let mockConnected = false;
let mockListener: ((event: { connected: boolean }) => void) | undefined;
const mockRemove = jest.fn();

jest.mock('../../../modules/app-group-storage/src', () => ({
  AppGroupStorage: { isHardwareKeyboardConnected: () => mockConnected },
  addHardwareKeyboardChangedListener: (listener: (event: { connected: boolean }) => void) => {
    mockListener = listener;
    return { remove: mockRemove };
  },
}));

import { useHardwareKeyboardConnected } from '../useHardwareKeyboardConnected';

beforeEach(() => {
  mockConnected = false;
  mockListener = undefined;
  mockRemove.mockClear();
});

describe('useHardwareKeyboardConnected', () => {
  it('starts from the native state', () => {
    mockConnected = true;
    const { result } = renderHook(() => useHardwareKeyboardConnected());
    expect(result.current).toBe(true);
  });

  it('follows connect and disconnect events', () => {
    const { result } = renderHook(() => useHardwareKeyboardConnected());
    expect(result.current).toBe(false);
    act(() => mockListener?.({ connected: true }));
    expect(result.current).toBe(true);
    act(() => mockListener?.({ connected: false }));
    expect(result.current).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useHardwareKeyboardConnected());
    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });
});
