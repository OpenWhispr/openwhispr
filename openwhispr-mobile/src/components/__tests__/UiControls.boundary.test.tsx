import React from 'react';
import { fireEvent, render, cleanupAsync } from '@testing-library/react-native';
import { Text } from 'react-native';

// Default entries must load and render without Android presentation dependencies.
jest.mock('react-i18next', () => {
  throw new Error('Android translation runtime reached a default UI control');
});
jest.mock('@/android/ui', () => {
  throw new Error('Android UI runtime reached a default UI control');
});
jest.mock('@react-native-menu/menu', () => {
  throw new Error('Android menu presentation reached a default UI control');
});
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GradientGlassSurface', () => ({ GradientGlassSurface: () => null }));
jest.mock('@/components/ui/Glass', () => ({
  Glass: { Interactive: require('react-native').View },
}));
jest.mock('expo-glass-effect', () => ({ GlassContainer: require('react-native').View }));
jest.mock('@/lib/fonts', () => ({ AppFont: { regular: 'fixture-font' } }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('lucide-react-native', () => ({ Trash2: () => null, FolderInput: () => null }));
jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const gesture = {
        activeOffsetX: () => gesture,
        onUpdate: () => gesture,
        onEnd: () => gesture,
      };
      return gesture;
    },
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useSharedValue: (initial: number) => require('react').useRef({ value: initial }).current,
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: number) => value,
  runOnJS: (fn: unknown) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' },
  Easing: { out: () => undefined, in: () => undefined },
}));

let mockFormProps: { title: string; submitLabel: string };
jest.mock('@/components/ui/FormSheet', () => ({
  FormSheet: (props: { title: string; submitLabel: string; children: React.ReactNode }) => {
    mockFormProps = props;
    return require('react').createElement(require('react-native').View, null, props.children);
  },
}));

afterEach(async () => {
  await cleanupAsync();
  jest.useRealTimers();
});

it.each([
  ['../ui/Fab', 'Fab', { icon: 'plus', mdIcon: 'Plus', accessibilityLabel: 'Fixture action' }],
  [
    '../ui/SwipeableCard',
    'SwipeableCard',
    { onDelete: jest.fn(), children: <Text>Retained row</Text> },
  ],
  [
    '../notes/NewFolderSheet',
    'NewFolderSheet',
    { visible: true, onClose: jest.fn(), onCreate: jest.fn() },
  ],
] as const)('renders the default %s without Android dependencies', (file, name, props) => {
  const Component = jest.requireActual(file)[name];
  const screen = render(<Component {...props} />);
  expect(screen.toJSON()).not.toBeNull();
});

it('retains the default floating menu action and close behavior', () => {
  const { Fab } = jest.requireActual<typeof import('../ui/Fab')>('../ui/Fab');
  const onActionPress = jest.fn();
  const screen = render(
    <Fab
      icon="plus"
      mdIcon="Plus"
      accessibilityLabel="Fixture menu"
      actions={[{ id: 'note', label: 'Fixture note', icon: 'doc', mdIcon: 'File' }]}
      onActionPress={onActionPress}
    />,
  );
  expect(screen.queryByLabelText('Fixture note')).toBeNull();
  fireEvent.press(screen.getByLabelText('Fixture menu'));
  fireEvent.press(screen.getByLabelText('Fixture note'));
  expect(onActionPress).toHaveBeenCalledWith('note');
  expect(screen.queryByLabelText('Fixture note')).toBeNull();
});

it('retains default creation copy and does not replace an iOS draft with Android rename state', () => {
  jest.useFakeTimers();
  const { NewFolderSheet } =
    jest.requireActual<typeof import('../notes/NewFolderSheet')>('../notes/NewFolderSheet');
  const props = {
    visible: true,
    initialName: 'Existing folder',
    onClose: jest.fn(),
    onCreate: jest.fn(),
  };
  const screen = render(<NewFolderSheet {...props} />);
  expect(mockFormProps).toMatchObject({ title: 'New Folder', submitLabel: 'Create Folder' });
  expect(screen.getByPlaceholderText('Folder name').props.value).toBe('');
  fireEvent.changeText(screen.getByPlaceholderText('Folder name'), 'User draft');
  screen.rerender(<NewFolderSheet {...props} initialName="Other folder" />);
  expect(screen.getByPlaceholderText('Folder name').props.value).toBe('User draft');
});
