import { renderHook, act } from '@testing-library/react-native';
import { shouldDismissSheetDrag, useSheetDragToDismiss } from '../useSheetDragToDismiss';

let mockOnEnd: (event: { translationY: number; velocityY: number }) => void;
let mockAnimationComplete: () => void;
const mockTranslate = { value: 0 };
jest.mock('react-native-reanimated', () => ({
  useSharedValue: () => mockTranslate,
  useAnimatedStyle: (fn: () => unknown) => fn(),
  runOnJS: (fn: () => void) => fn,
  withSpring: (value: number) => value,
  withTiming: (value: number, _options: unknown, complete: () => void) => {
    mockAnimationComplete = complete;
    return value;
  },
}));
jest.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const chain = {
        activeOffsetY: () => chain,
        onUpdate: () => chain,
        onEnd: (fn: typeof mockOnEnd) => {
          mockOnEnd = fn;
          return chain;
        },
      };
      return chain;
    },
  },
}));

it.each([
  ['a short pull', 60, 200, false],
  ['a pull past the distance', 140, 100, true],
  ['a quick fling', 40, 1200, true],
  ['an upward drag', -200, -1500, false],
])('treats %s as dismiss=%s', (_label, translationY, velocityY, expected) => {
  expect(shouldDismissSheetDrag(translationY, velocityY)).toBe(expected);
});

it('restores a dragged form when dismissal requires confirmation', () => {
  const close = jest.fn(() => false);
  renderHook(() => useSheetDragToDismiss(true, close));
  act(() => mockOnEnd({ translationY: 200, velocityY: 200 }));
  expect(mockTranslate.value).toBeGreaterThan(0);
  act(() => mockAnimationComplete());
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockTranslate.value).toBe(0);
});
