import { fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, Text } from 'react-native';
import { SwipeableCard } from '../SwipeableCard';

// Shared values in creation order; the card's translateX is the first one it makes.
const mockSharedValues: { value: number }[] = [];

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const easing = { cubic: 'cubic', quad: 'quad', out: () => 'out', in: () => 'in' };
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (initial: number) => {
      const sharedValue = { value: initial };
      mockSharedValues.push(sharedValue);
      return sharedValue;
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
  for (const method of ['activeOffsetX', 'onUpdate', 'onEnd']) gesture[method] = () => gesture;
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
  });

  it('slides the row away on Delete and lets the caller bring it back when the delete is cancelled', () => {
    const onDelete = jest.fn();
    render(
      <SwipeableCard onDelete={onDelete}>
        <Text>Row</Text>
      </SwipeableCard>,
    );

    fireEvent.press(screen.getByLabelText('Delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(translateX()).toBe(-Dimensions.get('window').width);

    const restore = onDelete.mock.calls[0][0] as () => void;
    restore();

    expect(translateX()).toBe(0);
  });
});
