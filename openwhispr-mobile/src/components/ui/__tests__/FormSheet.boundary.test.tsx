import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { cleanupAsync, render } from '@testing-library/react-native';
import { FormSheet } from '../FormSheet';

const mockPressables = new Map<symbol, Record<string, any>>(),
  mockKeyboardWrappers = new Map<symbol, Record<string, any>>();
const mockHookCalls: unknown[] = [];
let mockModal: Record<string, any> = {},
  mockHeight = 280,
  mockInsets = { top: 24, right: 0, bottom: 16, left: 0 },
  mockCopyCalls = 0;
const mockClose = jest.fn(),
  mockSubmit = jest.fn(),
  mockRemove = jest.fn();
const mockGesture = {},
  mockSheetStyle = { transform: [{ translateY: 0 }] };
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native.Platform, 'OS', { configurable: true, value: 'ios' });
  function captureNative(Component: any, getRecords: () => Map<symbol, Record<string, any>>) {
    return function CapturedNative(props: Record<string, any>) {
      const records = getRecords();
      const id = require('react').useRef(Symbol('fixture'));
      records.set(id.current, props);
      require('react').useEffect(
        () => () => {
          records.delete(id.current);
        },
        [],
      );
      return require('react').createElement(Component, props);
    };
  }
  return Object.defineProperties(Object.create(native), {
    Modal: {
      value: (props: Record<string, any>) => {
        mockModal = props;
        return props.visible
          ? require('react').createElement(native.View, { ...props, testID: 'fixture-modal' })
          : null;
      },
      enumerable: true,
    },
    Pressable: { value: captureNative(native.Pressable, () => mockPressables), enumerable: true },
    KeyboardAvoidingView: {
      value: captureNative(native.KeyboardAvoidingView, () => mockKeyboardWrappers),
      enumerable: true,
    },
  });
});
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => {
    mockCopyCalls++;
    return { copy: (_key: string, fallback: string) => fallback };
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => mockInsets }));
jest.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: (visible: boolean) => {
    mockHookCalls.push(['keyboard', visible]);
    return visible ? mockHeight : 0;
  },
}));
jest.mock('@/hooks/useSheetDragToDismiss', () => ({
  useSheetDragToDismiss: (visible: boolean, onClose: unknown) => {
    mockHookCalls.push(['drag', visible, onClose === mockClose]);
    return { dragGesture: mockGesture, sheetStyle: mockSheetStyle };
  },
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: Record<string, unknown>) =>
    require('react').createElement(require('react-native').View, {
      ...props,
      testID: 'fixture-root',
    }),
  GestureDetector: (props: Record<string, unknown>) =>
    require('react').createElement(require('react-native').View, {
      ...props,
      testID: 'fixture-gesture',
    }),
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: (props: Record<string, unknown>) =>
      require('react').createElement(require('react-native').View, {
        ...props,
        testID: 'fixture-animated',
      }),
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
jest.mock('@/components/ui/GradientGlassSurface', () => ({
  GradientGlassSurface: () =>
    require('react').createElement(require('react-native').View, { testID: 'fixture-gradient' }),
}));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: (props: Record<string, unknown>) =>
    require('react').createElement(require('react-native').Pressable, {
      ...props,
      testID: 'fixture-close',
    }),
}));

beforeEach(() => {
  mockPressables.clear();
  mockKeyboardWrappers.clear();
  mockHookCalls.length = 0;
  mockCopyCalls = 0;
});
afterEach(async () => {
  await cleanupAsync();
});
function mount(canSubmit = true) {
  return render(
    <FormSheet
      visible
      onClose={mockClose}
      title="Fixture form"
      submitLabel="Save"
      canSubmit={canSubmit}
      onSubmit={mockSubmit}
      destructiveAction={{ label: 'Delete', onPress: mockRemove }}
    >
      <Text>Retained input</Text>
    </FormSheet>,
  );
}
it('does not execute Android translation hooks from the default form', () => {
  mount();
  expect(mockCopyCalls).toBe(0);
});
it('retains the default content hierarchy and keyboard padding', () => {
  const view = mount();
  expect(mockKeyboardWrappers.size).toBe(0);
  function find(node: any): any {
    if (!node) return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (node.props?.className === 'px-5 pt-3.5') return node;
    return find(node.children);
  }
  const content = find(view.toJSON());
  expect(content).toBeTruthy();
  expect(StyleSheet.flatten(content.props.style).paddingBottom).toBe(290);
  expect(mockModal.onRequestClose).toBe(mockClose);
  expect(mockHookCalls).toEqual([
    ['keyboard', true],
    ['drag', true, true],
  ]);
});
it.each([false, true])(
  'retains upstream default button props and pressed styles when enabled=%s',
  (canSubmit) => {
    mount(canSubmit);
    const buttons = Array.from(mockPressables.values()),
      submit = buttons.find((x) => x.onPress === mockSubmit)!,
      remove = buttons.find((x) => x.onPress === mockRemove)!;
    expect(submit.disabled).toBe(!canSubmit);
    expect(submit.accessibilityRole).toBeUndefined();
    expect(submit.accessibilityState).toBeUndefined();
    expect(submit.className).toBe(
      `relative h-[52px] items-center justify-center rounded-full ${canSubmit ? 'bg-link' : 'bg-quaternarySystemFill'}`,
    );
    expect(typeof submit.style).toBe('function');
    expect(StyleSheet.flatten(submit.style({ pressed: false })).opacity).toBe(1);
    expect(StyleSheet.flatten(submit.style({ pressed: true })).opacity).toBe(canSubmit ? 0.9 : 1);
    expect(remove.className).toBe('mt-2.5 h-11 items-center justify-center');
    expect(remove.style({ pressed: false })).toEqual({ opacity: 1 });
    expect(remove.style({ pressed: true })).toEqual({ opacity: 0.6 });
  },
);
