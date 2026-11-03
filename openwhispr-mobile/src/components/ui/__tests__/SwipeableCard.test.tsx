import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, Platform, Text } from 'react-native';
import { SwipeableCard } from '../SwipeableCard';

// Shared values in creation order; the card's translateX is the first one it makes.
const mockSharedValues: { value: number }[] = [];
let mockPanUpdate: (event: { translationX: number }) => void;
let mockPanEnd: () => void;

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  const easing = { cubic: 'cubic', quad: 'quad', out: () => 'out', in: () => 'in' };
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (initial: number) => {
      const ref = useRef(null);
      if (!ref.current) {
        ref.current = { value: initial };
        mockSharedValues.push(ref.current);
      }
      return ref.current;
    },
    useAnimatedStyle: () => ({}),
    // Animations land on their target at once, finishing callbacks included.
    withTiming: (
      target: number,
      _config: unknown,
      onFinish?: (finished: boolean) => void,
    ): number => {
      onFinish?.(true);
      return target;
    },
    runOnJS: <Args extends unknown[]>(fn: (...args: Args) => void) => fn,
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
    Easing: easing,
  };
});
jest.mock('react-native-gesture-handler', () => {
  const gesture: Record<string, unknown> = {};
  gesture.activeOffsetX = () => gesture;
  gesture.onUpdate = (callback: typeof mockPanUpdate) => {
    mockPanUpdate = callback;
    return gesture;
  };
  gesture.onEnd = (callback: typeof mockPanEnd) => {
    mockPanEnd = callback;
    return gesture;
  };
  return {
    Gesture: { Pan: () => gesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('lucide-react-native', () => ({ Trash2: () => null, FolderInput: () => null }));
jest.mock('@/config/colors', () => ({ iosColor: () => '#000000' }));

const translateX = (): number => mockSharedValues[0].value;

describe('SwipeableCard', () => {
  beforeEach(() => {
    mockSharedValues.length = 0;
    Platform.OS = 'ios';
  });

  it('slides the row away on Delete and lets the caller bring it back when the delete is cancelled', () => {
    const onDelete = jest.fn();
    render(
      <SwipeableCard onDelete={onDelete}>
        <Text>Row</Text>
      </SwipeableCard>,
    );

    act(() => {
      mockPanUpdate({ translationX: -100 });
      mockPanEnd();
    });
    fireEvent.press(screen.getByLabelText('Delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(translateX()).toBe(-Dimensions.get('window').width);

    const restore = onDelete.mock.calls[0][0] as () => void;
    act(restore);

    expect(translateX()).toBe(0);
  });
});
