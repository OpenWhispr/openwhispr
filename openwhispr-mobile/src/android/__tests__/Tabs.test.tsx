import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import AndroidTabs from '../Tabs';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 8, left: 0 }),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('../ui', () => ({ palette: {} }));
// Exercise our sizing with measured native text heights; Jest does not lay out text.
jest.mock('expo-router', () => {
  const { View } = require('react-native');
  const ReactModule = require('react');
  const Tabs = ({ screenOptions, children }: any) => (
    <View testID="tab-bar" style={screenOptions.tabBarStyle}>
      {ReactModule.Children.map(children, (child: any) =>
        screenOptions.tabBarLabel({ color: '#000000', children: child.props.options.title }),
      )}
    </View>
  );
  Tabs.Screen = () => null;
  return { Tabs, useSegments: () => ['(record)'] };
});

beforeEach(() => {
  jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({
    width: 320,
    height: 718,
    scale: 3.375,
    fontScale: 2,
  });
});
afterEach(() => jest.restoreAllMocks());

it('keeps room for the tallest wrapped label even after a shorter label reports its height', () => {
  render(<AndroidTabs />);
  fireEvent(screen.getByText('dictionary'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 54, height: 84 } },
  });
  fireEvent(screen.getByText('home'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 54, height: 28 } },
  });
  const height = ReactNative.StyleSheet.flatten(screen.getByTestId('tab-bar').props.style).height;
  // 84 points of text, a 28-point icon, 10 points of padding and the 8-point inset.
  expect(height).toBeGreaterThanOrEqual(130);
});

it('drops stale large-font measurements after the display scale and width change', () => {
  const { rerender } = render(<AndroidTabs />);
  fireEvent(screen.getByText('dictionary'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 54, height: 84 } },
  });
  const largeHeight = ReactNative.StyleSheet.flatten(
    screen.getByTestId('tab-bar').props.style,
  ).height;
  jest.mocked(ReactNative.useWindowDimensions).mockReturnValue({
    width: 411,
    height: 923,
    scale: 2.625,
    fontScale: 1,
  });
  rerender(<AndroidTabs />);
  fireEvent(screen.getByText('dictionary'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 72, height: 16 } },
  });
  const normalHeight = ReactNative.StyleSheet.flatten(
    screen.getByTestId('tab-bar').props.style,
  ).height;
  expect(normalHeight).toBeLessThan(largeHeight);
  expect(normalHeight).toBeGreaterThanOrEqual(64 + 8);
});
