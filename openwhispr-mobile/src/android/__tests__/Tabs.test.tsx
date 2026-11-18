import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard, StyleSheet } from 'react-native';
import { AndroidTabBar } from '../Tabs';
import { useNavigationBarCanvas } from '../navigationBar';

jest.mock('expo-router', () => ({ Tabs: () => null }));
jest.mock('@react-navigation/native', () => ({
  CommonActions: { navigate: (route: { name: string }) => ({ type: 'NAVIGATE', payload: route }) },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('../home/strings', () => ({
  useHomeT: () => (_key: string, o: { index: number; count: number }) => `${o.index} of ${o.count}`,
}));
jest.mock('../home/kit', () => ({
  home: {
    canvas: 'canvas',
    surface: 'surface',
    divider: 'divider',
    text: 'primary',
    secondary: 'secondary',
    tint: 'tint',
    accent: 'accent',
  },
}));
jest.mock('../navigationBar', () => ({ useNavigationBarCanvas: jest.fn() }));

const names = ['(record)', '(notes)', '(chat)', '(dictionary)', '(style)'];
function props(focused = 1, notesStack?: string[], tabBarStyle?: object) {
  const routes = names.map((name) => ({
    key: name,
    name,
    ...(name === '(notes)' && notesStack
      ? { state: { index: notesStack.length - 1, routes: notesStack.map((n) => ({ name: n })) } }
      : {}),
  }));
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), dispatch: jest.fn() };
  const descriptors = Object.fromEntries(
    names.map((name) => [
      name,
      {
        options: { title: name.slice(1, -1), ...(name === names[focused] ? { tabBarStyle } : {}) },
      },
    ]),
  );
  return {
    state: { key: 'tabs', index: focused, routes },
    descriptors,
    navigation,
    insets: { top: 0, right: 0, bottom: 24, left: 0 },
  } as any;
}

it('shows four tabs, Chat hidden, each a TalkBack tab with its place and selection', () => {
  render(<AndroidTabBar {...props(1)} />);
  expect(screen.queryByTestId('tab-(chat)')).toBeNull();
  const notes = screen.getByTestId('tab-(notes)');
  expect(notes.props.accessibilityRole).toBe('tab');
  expect(notes.props.accessibilityLabel).toBe('notes, 2 of 4');
  expect(notes.props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByTestId('tab-(style)').props.accessibilityLabel).toBe('style, 4 of 4');
  expect(screen.getByTestId('tab-(record)').props.accessibilityState).toEqual({ selected: false });
});

it('is white with a hairline on top, 80 dp above the system inset', () => {
  render(<AndroidTabBar {...props(1)} />);
  const bar = screen.getByTestId('tab-bar');
  expect(bar.props.style).toMatchObject({
    backgroundColor: 'surface',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'divider',
    minHeight: 104,
    paddingBottom: 24,
  });
  expect(bar.props.style.boxShadow).toBeUndefined();
  expect(bar.props.style.elevation).toBeUndefined();
});

it('paints the system bar white under the bar and the page colour where the bar hides', () => {
  render(<AndroidTabBar {...props(1)} />);
  expect(useNavigationBarCanvas).toHaveBeenLastCalledWith('surface');
  render(<AndroidTabBar {...props(1, ['index', '[id]'])} />);
  expect(useNavigationBarCanvas).toHaveBeenLastCalledWith('canvas');
});

it('hides on a pushed screen', () => {
  render(<AndroidTabBar {...props(1, ['index', 'actions'])} />);
  expect(screen.queryByTestId('tab-bar')).toBeNull();
});

it("still respects tabBarStyle display: 'none'", () => {
  render(<AndroidTabBar {...props(1, undefined, { display: 'none' })} />);
  expect(screen.queryByTestId('tab-bar')).toBeNull();
});

it('hides while the keyboard is up', () => {
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
    listeners[event] = cb;
    return { remove: jest.fn() };
  }) as any);
  render(<AndroidTabBar {...props(0)} />);
  act(() => listeners.keyboardDidShow());
  expect(screen.queryByTestId('tab-bar')).toBeNull();
  act(() => listeners.keyboardDidHide());
  expect(screen.getByTestId('tab-bar')).toBeTruthy();
});

it('tapping the tab you are on only emits tabPress, so its stack pops and scrolls to top', () => {
  const p = props(1);
  render(<AndroidTabBar {...p} />);
  fireEvent.press(screen.getByTestId('tab-(notes)'));
  expect(p.navigation.emit).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'tabPress', target: '(notes)', canPreventDefault: true }),
  );
  expect(p.navigation.dispatch).not.toHaveBeenCalled();
});

it('tapping another tab switches to it', () => {
  const p = props(1);
  render(<AndroidTabBar {...p} />);
  fireEvent.press(screen.getByTestId('tab-(dictionary)'));
  expect(p.navigation.dispatch).toHaveBeenCalledWith(expect.objectContaining({ target: 'tabs' }));
});
