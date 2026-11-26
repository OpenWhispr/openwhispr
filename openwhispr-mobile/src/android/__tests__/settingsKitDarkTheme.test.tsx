import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, TextInput, useColorScheme } from 'react-native';

jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: async () => true,
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
const mockNavBar = jest.fn();
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: (colour: string) => mockNavBar(colour),
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color, mdName }: { color: string; mdName?: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID={`glyph-${mdName}`} accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('@/android/shared/hooks/useKeyboardHeight', () =>
  jest.requireMock('@/hooks/useKeyboardHeight'),
);

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import {
  Badge,
  BottomSheet,
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  settings as lightSettings,
  useSettings,
} from '../settings/kit';
import { useSettingsLook } from '../settings/look';

type Node = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const textColour = (text: string) => flat(screen.getByText(text).props.style).color;
function fillOf(node: Node) {
  for (let n: Node | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}

function Page({ onChange }: { onChange?: (text: string) => void }) {
  return (
    <SettingsPage title="Settings">
      <Group title="Account" footer="Footer copy">
        <ListRow icon="User" title="Profile" subtitle="Plan" value="Pro" onPress={() => {}} />
        <ListRow icon="LogOut" title="Sign out" destructive onPress={() => {}} />
      </Group>
      <Badge label="Recommended" />
      <PillAction label="Sign out pill" onPress={() => {}} />
      <PillAction label="Glass pill" primary onPress={() => {}} />
      <TextInput testID="field" onChangeText={onChange} />
    </SettingsPage>
  );
}

const tree = () => (
  <ThemeProvider>
    <Page />
  </ThemeProvider>
);

async function switchTo(scheme: 'light' | 'dark', rerender: (node: React.ReactElement) => void) {
  mockScheme.mockReturnValue(scheme);
  await act(async () => {
    rerender(tree());
  });
}

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockNavBar.mockClear();
});

it.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('draws the kit in %s', (scheme, k) => {
  mockScheme.mockReturnValue(scheme);
  render(tree());
  expect(textColour('Settings')).toBe(k.ink);
  expect(textColour('Profile')).toBe(k.ink);
  expect(textColour('Plan')).toBe(k.secondary);
  expect(textColour('Pro')).toBe(k.tertiary);
  expect(textColour('Sign out')).toBe(k.error);
  expect(textColour('Account')).toBe(k.tertiary);
  expect(textColour('Recommended')).toBe(k.accent);
  expect(fillOf(screen.getByText('Recommended'))).toBe(k.selFill);
  expect(textColour('Glass pill')).toBe(k.onGlass);
  expect(textColour('Sign out pill')).toBe(k.ink);
  expect(mockNavBar).toHaveBeenLastCalledWith(k.canvas);
});

it('builds each scheme once and keeps the light aliases light', () => {
  const seen: unknown[] = [];
  function Probe() {
    seen.push(useSettings(), useSettingsLook());
    return null;
  }
  mockScheme.mockReturnValue('dark');
  const { rerender } = render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  rerender(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
  expect(seen[0]).toBe(seen[2]);
  expect(seen[1]).toBe(seen[3]);
  expect((seen[0] as typeof lightSettings).text).toBe(darkTheme.ink);
  expect(lightSettings.text).toBe(lightTheme.ink);
});

it('switches in place: same rows and field, typed text kept', async () => {
  const { rerender } = render(tree());
  const row = screen.getByText('Profile');
  const field = screen.getByTestId('field');
  fireEvent.changeText(field, 'half a sentence');
  // An uncontrolled input keeps its native text; the instance must survive the switch.
  await switchTo('dark', rerender);
  expect(screen.getByText('Profile')).toBe(row);
  expect(screen.getByTestId('field')).toBe(field);
  expect(textColour('Profile')).toBe(darkTheme.ink);
  await switchTo('light', rerender);
  expect(screen.getByTestId('field')).toBe(field);
  expect(textColour('Profile')).toBe(lightTheme.ink);
});

it('repaints an open bottom sheet without closing it', async () => {
  const sheet = () => (
    <ThemeProvider>
      <BottomSheet visible onClose={() => {}} title="Sign out?" body="You can sign back in">
        <PillAction label="Confirm" destructive onPress={() => {}} />
      </BottomSheet>
    </ThemeProvider>
  );
  const { rerender } = render(sheet());
  const title = screen.getByText('Sign out?');
  expect(textColour('Sign out?')).toBe(lightTheme.ink);
  mockScheme.mockReturnValue('dark');
  await act(async () => {
    rerender(sheet());
  });
  expect(screen.getByText('Sign out?')).toBe(title);
  expect(textColour('Sign out?')).toBe(darkTheme.ink);
  expect(textColour('You can sign back in')).toBe(darkTheme.ink);
  expect(textColour('Confirm')).toBe(darkTheme.error);
});
