import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Platform, Text } from 'react-native';
import { SwipeableCard } from '../SwipeableCard';
import { confirmDestructive } from '@/lib/alerts';

let mockPan: { update?: (event: { translationX: number }) => void; end?: () => void } = {};
const mockValues: { value: number }[] = [];
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const chain = {
        activeOffsetX: () => chain,
        onUpdate: (callback: typeof mockPan.update) => {
          mockPan.update = callback;
          return chain;
        },
        onEnd: (callback: typeof mockPan.end) => {
          mockPan.end = callback;
          return chain;
        },
      };
      return chain;
    },
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (initial: number) => {
    const ref = require('react').useRef(null);
    if (ref.current === null) {
      ref.current = { value: initial };
      mockValues.push(ref.current);
    }
    return ref.current;
  },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: number, _options: unknown, complete?: (finished: boolean) => void) => {
    complete?.(true);
    return value;
  },
  runOnJS: (fn: unknown) => fn,
  interpolate: () => 1,
  Extrapolation: { CLAMP: 'clamp' },
  Easing: { in: () => undefined, out: () => undefined, cubic: undefined },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
  }),
}));
jest.mock('lucide-react-native', () => ({ Trash2: () => null, FolderInput: () => null }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

const originalOS = Platform.OS;
let alert: jest.SpyInstance;
beforeEach(() => {
  Platform.OS = 'android';
  mockValues.length = 0;
  mockPan = {};
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  Platform.OS = originalOS;
  alert.mockRestore();
});
const reveal = () =>
  act(() => {
    mockPan.update?.({ translationX: -120 });
    mockPan.end?.();
  });

function ConfirmedRow({ remove, move }: { remove: () => void; move?: () => void }) {
  const [visible, setVisible] = useState(true);
  return visible ? (
    <SwipeableCard
      onMove={move}
      onDelete={() =>
        confirmDestructive('Delete note', 'This note will be deleted permanently.', () => {
          remove();
          setVisible(false);
        })
      }
    >
      <Text>Retained note</Text>
    </SwipeableCard>
  ) : null;
}

it('returns the row to view before confirmation so Cancel leaves it visible and reusable', () => {
  const remove = jest.fn();
  const view = render(<ConfirmedRow remove={remove} />);
  for (let attempt = 0; attempt < 2; attempt++) {
    reveal();
    fireEvent.press(view.getByLabelText('Delete'));
    const buttons = alert.mock.calls[attempt][2];
    act(() => buttons.find((button: { style: string }) => button.style === 'cancel').onPress?.());
    expect(remove).not.toHaveBeenCalled();
    expect(view.getByText('Retained note')).toBeTruthy();
    expect(mockValues[0].value).toBe(0);
    expect(view.queryByLabelText('Delete')).toBeNull();
  }
});

it('only removes the row after the caller confirms deletion', () => {
  const remove = jest.fn();
  const view = render(<ConfirmedRow remove={remove} />);
  reveal();
  fireEvent.press(view.getByLabelText('Delete'));
  expect(remove).not.toHaveBeenCalled();
  act(() =>
    alert.mock.calls[0][2]
      .find((button: { style: string }) => button.style === 'destructive')
      .onPress(),
  );
  expect(remove).toHaveBeenCalledTimes(1);
  expect(view.queryByText('Retained note')).toBeNull();
});

it('still closes the swipe actions when moving without invoking deletion', () => {
  const move = jest.fn();
  const remove = jest.fn();
  const view = render(<ConfirmedRow remove={remove} move={move} />);
  reveal();
  fireEvent.press(view.getByLabelText('Move'));
  expect(move).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(mockValues[0].value).toBe(0);
  expect(view.queryByLabelText('Delete')).toBeNull();
});
