import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text as RNText, useColorScheme } from 'react-native';

/**
 * Dark theme, segment 7 (Account flows): the launch screens, the signed-out sheet, the shared
 * system colours (`iosColor`), the older page kit (`android/ui`) and the shared `.android` parts
 * the theme guard used to list as pending.
 */
const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
  fadeTheme: jest.fn(),
}));
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: jest.fn(() => 'light'),
}));
const mockStatusBar = jest.fn();
jest.mock('expo-status-bar', () => ({
  StatusBar: ({ style }: { style: string }) => {
    mockStatusBar(style);
    return null;
  },
}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const entering: Record<string, unknown> = {};
  entering.duration = () => entering;
  entering.delay = () => entering;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (component: unknown) => component },
    Easing: { linear: 0, quad: 0, out: () => 0 },
    FadeIn: entering,
    FadeOut: entering,
    useAnimatedStyle: () => ({}),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: unknown) => value,
  };
});
jest.mock('expo-linear-gradient', () => ({ LinearGradient: require('react-native').View }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true, replace: jest.fn() },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key },
}));
jest.mock('../launch/strings', () => ({ useLaunchT: () => (key: string) => key }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/OpenWhisprMark', () => ({ OpenWhisprMark: () => null }));
jest.mock('@/android/shared/components/ui/OpenWhisprMark', () =>
  jest.requireMock('@/components/ui/OpenWhisprMark'),
);
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../settings/kit', () => ({
  BottomSheet: ({
    visible,
    above,
    children,
  }: {
    visible: boolean;
    above: React.ReactNode;
    children: React.ReactNode;
  }) => (visible ? [above, children] : null),
}));
// Jest resolves the iOS SystemIcon for screens; the Android one is imported by name below.
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color }: { color: string }) => {
    const { View } = require('react-native');
    return <View testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('@react-native-menu/menu', () => ({
  MenuView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('lucide-react-native', () => {
  const { View } = require('react-native');
  return new Proxy(
    {},
    {
      get: () => (props: { color: string }) => (
        <View testID="lucide" accessibilityHint={props.color} />
      ),
    },
  );
});

import { ThemeProvider } from '../ThemeProvider';
import { CouldNotOpen, LaunchSplash, SignedOutSheet } from '../launch/LaunchScreens';
import { useEndedSession } from '../auth/endedSession';
import { iosColor, useIosColor } from '@/config/colors.android';
import { Button, Card } from '../ui';
import { SystemIcon } from '@/components/ui/SystemIcon.android';
import { darkTheme, lightTheme } from '../theme';

const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
type Node = ReturnType<typeof screen.getByText>;
/** The nearest host view above [node] with a background. */
function fillOf(node: Node) {
  for (let n: Node | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}
const textColour = (text: string) => flat(screen.getByText(text).props.style).color;

function inTheme(scheme: 'light' | 'dark', node: () => React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{node()}</ThemeProvider>);
}
async function switchTo(
  scheme: 'light' | 'dark',
  rerender: (node: React.ReactElement) => void,
  node: () => React.ReactElement,
) {
  mockScheme.mockReturnValue(scheme);
  await act(async () => {
    rerender(<ThemeProvider>{node()}</ThemeProvider>);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScheme.mockReturnValue('light');
  useEndedSession.setState({ user: null, sheetPending: false });
});

describe.each(['light', 'dark'] as const)('the opening splash in %s', (scheme) => {
  it('repeats the light native splash, with dark status icons', () => {
    inTheme(scheme, () => <LaunchSplash slow />);
    expect(fillOf(screen.getByText('opening'))).toBe(lightTheme.canvas);
    expect(textColour('opening')).toBe(lightTheme.tertiary);
    expect(mockStatusBar).toHaveBeenLastCalledWith('dark');
  });
});

describe('the could-not-open screen', () => {
  it.each([
    ['light', lightTheme, 'dark'],
    ['dark', darkTheme, 'light'],
  ] as const)('follows the scheme in %s', (scheme, k, statusIcons) => {
    inTheme(scheme, () => <CouldNotOpen details="SQLITE_CORRUPT" onRetry={jest.fn()} />);
    expect(fillOf(screen.getByText('couldNotOpenBody'))).toBe(k.canvas);
    expect(textColour('couldNotOpen')).toBe(k.ink);
    expect(textColour('couldNotOpenBody')).toBe(k.tertiary);
    expect(textColour('!')).toBe(k.amber);
    expect(fillOf(screen.getByText('!'))).toBe(k.surface);
    expect(mockStatusBar).toHaveBeenLastCalledWith(statusIcons);
  });

  it('keeps "Details copied" across a switch (§3b)', async () => {
    const tree = () => <CouldNotOpen details="SQLITE_CORRUPT" onRetry={jest.fn()} />;
    const { rerender } = inTheme('light', tree);
    await act(async () => {
      fireEvent.press(screen.getByText('copyDetails'));
    });
    expect(screen.getByText('detailsCopied')).toBeTruthy();
    await switchTo('dark', rerender, tree);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('detailsCopied')).toBeTruthy();
    expect(textColour('couldNotOpen')).toBe(darkTheme.ink);
    expect(mockStatusBar).toHaveBeenLastCalledWith('light');
  });
});

describe('the signed-out sheet', () => {
  const ended = () =>
    useEndedSession.setState({
      user: { id: 'u1', email: 'alex@example.com' } as never,
      sheetPending: true,
    });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('draws its lock tile and Not now in %s', (scheme, k) => {
    ended();
    inTheme(scheme, () => <SignedOutSheet />);
    expect(textColour('notNow')).toBe(k.ink);
    const lock = screen.getByTestId('glyph');
    expect(lock.props.accessibilityHint).toBe(k.ink);
    expect(fillOf(lock)).toBe(k.surface);
  });

  it('stays open across a switch', async () => {
    ended();
    const tree = () => <SignedOutSheet />;
    const { rerender } = inTheme('dark', tree);
    await switchTo('light', rerender, tree);
    expect(screen.getByText('notNow')).toBeTruthy();
    expect(textColour('notNow')).toBe(lightTheme.ink);
  });
});

describe('system colours on Android (iosColor)', () => {
  it('keeps the light overrides exactly', () => {
    expect(iosColor('secondaryLabel')).toBe('#69666F');
    expect(iosColor('tertiaryLabel')).toBe('#737078');
    expect(iosColor('systemBackground')).toBe(lightTheme.canvas);
    expect(iosColor('tertiarySystemBackground')).toBe(lightTheme.surface);
  });

  it('maps every system colour an Android file reads onto a dark token', () => {
    expect(iosColor('label', 'dark')).toBe(darkTheme.ink);
    expect(iosColor('secondaryLabel', 'dark')).toBe(darkTheme.secondary);
    expect(iosColor('tertiaryLabel', 'dark')).toBe(darkTheme.tertiary);
    expect(iosColor('systemBackground', 'dark')).toBe(darkTheme.canvas);
    expect(iosColor('secondarySystemGroupedBackground', 'dark')).toBe(darkTheme.surface);
    expect(iosColor('tertiarySystemFill', 'dark')).toBe(darkTheme.track);
    expect(iosColor('link', 'dark')).toBe(darkTheme.accent);
    expect(iosColor('systemRed', 'dark')).toBe(darkTheme.error);
  });

  it('follows the scheme in use through useIosColor and SystemIcon', async () => {
    function Probe() {
      const colour = useIosColor();
      return (
        <>
          <RNText>{colour('tertiaryLabel')}</RNText>
          <SystemIcon name="xmark" mdName="X" color="secondaryLabel" />
        </>
      );
    }
    const tree = () => <Probe />;
    const { rerender } = inTheme('light', tree);
    expect(screen.getByText('#737078')).toBeTruthy();
    expect(screen.getByTestId('lucide').props.accessibilityHint).toBe('#69666F');
    await switchTo('dark', rerender, tree);
    expect(screen.getByText(darkTheme.tertiary)).toBeTruthy();
    expect(screen.getByTestId('lucide').props.accessibilityHint).toBe(darkTheme.secondary);
  });
});

describe('the older page kit (android/ui)', () => {
  it.each([
    ['light', lightTheme, lightTheme.accent],
    ['dark', darkTheme, darkTheme.glassBottom],
  ] as const)('draws cards and the blue button from the theme in %s', (scheme, k, button) => {
    inTheme(scheme, () => (
      <Card>
        <Button label="Start" onPress={jest.fn()} />
      </Card>
    ));
    expect(textColour('Start')).toBe(k.onGlass);
    const start = screen.getByText('Start');
    expect(fillOf(start)).toBe(button);
    expect(fillOf(start.parent!.parent!.parent!)).toBe(k.surface);
  });
});
