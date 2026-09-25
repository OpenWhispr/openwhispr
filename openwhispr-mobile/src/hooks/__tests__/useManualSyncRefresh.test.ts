import { act, renderHook } from '@testing-library/react-native';
import { useSyncStore } from '@/sync/useSyncStore';

let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocused,
}));

let mockSettleSync: () => void = () => {};
const mockRequestSync = jest.fn(() => new Promise<void>((resolve) => (mockSettleSync = resolve)));
jest.mock('@/sync/syncEngine', () => ({
  requestSync: (...args: unknown[]) => mockRequestSync(...(args as [])),
}));

import { useManualSyncRefresh } from '../useManualSyncRefresh';

beforeEach(() => {
  mockIsFocused = true;
  mockRequestSync.mockClear();
  useSyncStore.setState({ status: 'idle' });
});

describe('useManualSyncRefresh', () => {
  // Driving the spinner from every sync is what left it stuck: background syncs
  // (after a dictation, on foreground) flip it while the screen is off-window.
  it('ignores syncs the user did not pull for', () => {
    const { result } = renderHook(() => useManualSyncRefresh());

    act(() => useSyncStore.setState({ status: 'running' }));

    expect(result.current.refreshing).toBe(false);
  });

  it('shows the spinner from the pull until that sync settles', async () => {
    const { result } = renderHook(() => useManualSyncRefresh());

    act(() => result.current.onRefresh());
    expect(mockRequestSync).toHaveBeenCalledWith('manual');
    expect(result.current.refreshing).toBe(true);

    await act(async () => mockSettleSync());
    expect(result.current.refreshing).toBe(false);
  });

  // Ending a UIRefreshControl on an off-window scroll view is the same stuck
  // state, so a sync that settles after the user navigated away ends it on return.
  it('holds the spinner while the screen is unfocused and ends it once focused again', async () => {
    const { result, rerender } = renderHook(() => useManualSyncRefresh());
    act(() => result.current.onRefresh());

    mockIsFocused = false;
    rerender({});
    await act(async () => mockSettleSync());
    expect(result.current.refreshing).toBe(true);

    mockIsFocused = true;
    rerender({});
    expect(result.current.refreshing).toBe(false);
  });
});
