import { renderHook } from '@testing-library/react-native';
import { useLoopValue, usePulseStyle } from '../useChatMotion';

let mockReducedMotion = false;
const mockWithRepeat = jest.fn((value: unknown) => value);
const mockWithTiming = jest.fn((value: number) => value);

jest.mock('react-native-reanimated', () => ({
  Easing: { inOut: jest.fn(), ease: jest.fn(), linear: jest.fn() },
  cancelAnimation: jest.fn(),
  useAnimatedStyle: (factory: () => object) => factory(),
  useReducedMotion: () => mockReducedMotion,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (...args: [unknown]) => mockWithRepeat(...args),
  withTiming: (...args: [number]) => mockWithTiming(...args),
}));

describe('useChatMotion', () => {
  beforeEach(() => {
    mockReducedMotion = false;
    mockWithRepeat.mockClear();
    mockWithTiming.mockClear();
  });

  it('starts a looping animation by default', () => {
    const { result } = renderHook(() => useLoopValue(900, true));
    expect(mockWithRepeat).toHaveBeenCalledTimes(1);
    expect(result.current.value).toBe(1);
  });

  it('does not start any loop under reduced motion', () => {
    mockReducedMotion = true;
    const { result } = renderHook(() => useLoopValue(900, true));
    expect(mockWithRepeat).not.toHaveBeenCalled();
    expect(mockWithTiming).not.toHaveBeenCalled();
    expect(result.current.value).toBe(0);
  });

  it('does not start a loop while disabled', () => {
    renderHook(() => useLoopValue(900, true, false));
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('keeps a pulse at full opacity under reduced motion', () => {
    mockReducedMotion = true;
    const { result } = renderHook(() => usePulseStyle(0.4, 900));
    expect(result.current).toEqual({ opacity: 1 });
  });
});
