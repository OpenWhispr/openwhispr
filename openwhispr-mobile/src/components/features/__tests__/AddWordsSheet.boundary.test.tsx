import React from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { act, cleanupAsync, fireEvent, render } from '@testing-library/react-native';
import { AddWordsSheet } from '../AddWordsSheet';

const mockCalls: unknown[] = [],
  mockPressables = new Map<symbol, Record<string, any>>();
let mockForm: Record<string, any> = {},
  mockCopyCalls = 0;
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native.Platform, 'OS', { configurable: true, value: 'ios' });
  return Object.defineProperty(Object.create(native), 'Pressable', {
    enumerable: true,
    value: function RecordedPressable(props: Record<string, any>) {
      const id = require('react').useRef(Symbol('chip'));
      mockPressables.set(id.current, props);
      require('react').useEffect(
        () => () => {
          mockPressables.delete(id.current);
        },
        [],
      );
      return require('react').createElement(native.Pressable, props);
    },
  });
});
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => {
    mockCopyCalls++;
    return { copy: (_key: string, fallback: string) => fallback };
  },
}));
jest.mock('@/components/ui/FormSheet', () => ({
  FormSheet: (props: Record<string, any>) => {
    mockForm = props;
    return props.visible
      ? require('react').createElement(
          require('react-native').View,
          { testID: 'fixture-form' },
          props.children,
        )
      : null;
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: (props: Record<string, unknown>) =>
    require('react').createElement(require('react-native').View, {
      ...props,
      testID: 'fixture-icon',
    }),
}));
jest.mock('@/config/colors', () => ({ iosColor: (name: string) => 'fixture-' + name }));
jest.mock('@/lib/fonts', () => ({ AppFont: { regular: 'fixture-font' } }));
jest.mock('@/lib/utils', () => ({
  safeHaptics: (...args: unknown[]) => mockCalls.push(['haptic', ...args]),
}));

beforeEach(() => {
  mockCalls.length = 0;
  mockPressables.clear();
  mockCopyCalls = 0;
  jest.useFakeTimers();
});
afterEach(async () => {
  await cleanupAsync();
  act(() => jest.runAllTicks());
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
function mount() {
  return render(<AddWordsSheet visible onClose={jest.fn()} onSubmit={jest.fn()} />);
}
it('does not execute Android translation hooks from the default entry', () => {
  mount();
  expect(mockCopyCalls).toBe(0);
});
it('retains the upstream default input props', () => {
  const view = mount();
  const input = view.UNSAFE_getByType(TextInput);
  expect(input.props.accessibilityLabel).toBeUndefined();
  expect(input.props.multiline).toBeUndefined();
  expect(input.props.submitBehavior).toBeUndefined();
});
it('retains single-object pressed styles and absent text style on default chips', () => {
  const view = mount();
  fireEvent.changeText(view.UNSAFE_getByType(TextInput), 'Synty, The word is Synty');
  const chips = Array.from(mockPressables.values());
  expect(chips).toHaveLength(2);
  for (const [index, chip] of chips.entries()) {
    const idle = chip.style({ pressed: false }),
      pressed = chip.style({ pressed: true });
    expect(Array.isArray(idle)).toBe(false);
    expect(Array.isArray(pressed)).toBe(false);
    expect(idle).toEqual({
      borderCurve: 'continuous',
      backgroundColor: index ? 'rgba(0,122,255,0.12)' : undefined,
      opacity: 1,
    });
    expect(StyleSheet.flatten(pressed).opacity).toBe(0.6);
  }
  expect(view.getByText('Synty').props.style).toBeUndefined();
  expect(view.getByText('The word is Synty').props.style).toBeUndefined();
  expect(mockForm.canSubmit).toBe(true);
});
