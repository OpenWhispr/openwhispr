import React from 'react';
import { TextInput } from 'react-native';
import { act, cleanupAsync, render } from '@testing-library/react-native';
import { AddSnippetSheet } from '../AddSnippetSheet';
import { confirmDestructive } from '@/lib/alerts';

let mockForm: Record<string, any> = {},
  mockCopyCalls = 0;
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native.Platform, 'OS', { configurable: true, value: 'ios' });
  return native;
});
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => {
    mockCopyCalls++;
    return { copy: (_key: string, fallback: string) => fallback };
  },
}));
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/components/ui/FormSheet', () => ({
  FormSheet: (props: Record<string, any>) => {
    mockForm = props;
    return props.visible
      ? require('react').createElement(require('react-native').View, {}, props.children)
      : null;
  },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/config/colors', () => ({ iosColor: (name: string) => 'fixture-' + name }));
jest.mock('@/lib/fonts', () => ({ AppFont: { regular: 'fixture-font' } }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));

beforeEach(() => {
  mockCopyCalls = 0;
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(async () => {
  await cleanupAsync();
  act(() => jest.runAllTicks());
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
function mount() {
  return render(
    <AddSnippetSheet
      visible
      onClose={jest.fn()}
      onSubmit={jest.fn()}
      onDelete={jest.fn()}
      initial={{ trigger: 'original', replacement: 'Original text' }}
      existingTriggers={[]}
    />,
  );
}
it('does not execute Android translation hooks from the default snippet entry', () => {
  mount();
  expect(mockCopyCalls).toBe(0);
});
it('retains absent default field accessibility and keyboard submission props', () => {
  const view = mount();
  const [trigger, replacement] = view.UNSAFE_getAllByType(TextInput);
  for (const field of [trigger, replacement])
    expect(Object.hasOwn(field.props, 'accessibilityLabel')).toBe(false);
  expect(Object.hasOwn(trigger.props, 'submitBehavior')).toBe(false);
  expect(Object.hasOwn(trigger.props, 'onSubmitEditing')).toBe(false);
});
it('retains the three-argument upstream delete confirmation', () => {
  mount();
  act(() => mockForm.destructiveAction.onPress());
  expect(confirmDestructive).toHaveBeenCalledWith(
    'Delete snippet?',
    '"original" will be deleted.',
    expect.any(Function),
  );
});
