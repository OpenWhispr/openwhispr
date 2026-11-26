import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';

const mockPrepare = jest.fn(async () => true);
jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: () => mockPrepare(),
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
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
jest.mock('@/android/strings', () => ({
  __esModule: true,
  default: { addResourceBundle: jest.fn(), t: (key: string) => key, exists: () => false },
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({
  SystemIcon: ({ color, mdName }: { color: string; mdName: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID={`glyph-${mdName}`} accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors, children }: { colors: string[]; children?: React.ReactNode }) => {
    const { View: Gradient } = require('react-native');
    return (
      <Gradient testID="gradient" accessibilityHint={colors.join(' ')}>
        {children}
      </Gradient>
    );
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
    ZoomIn: entering,
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useFrameCallback: () => undefined,
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withDelay: (_: number, value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
// The Accessibility sheet uses the Settings kit, which imports the router and expo-image.
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('react-native-svg', () => {
  const { View: Shape } = require('react-native');
  const svg = ({ children }: { children?: React.ReactNode }) => <Shape>{children}</Shape>;
  return { __esModule: true, default: svg, Svg: svg, Path: () => null, Circle: () => null };
});
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: {
    getStatus: () => ({
      overlay: false,
      accessibility: false,
      enabled: false,
      batteryExempt: false,
      microphone: false,
    }),
    getRecordingLevel: () => 0,
    openSettings: jest.fn(),
  },
  dictationEvents: { addListener: () => ({ remove: jest.fn() }) },
}));
jest.mock('../onboarding/practiceRecorder', () => ({
  PracticeRecorder: class {},
  practiceFailure: () => '',
  requestMicrophone: async () => 'granted',
}));
jest.mock('../onboarding/accountOnboarding', () => ({
  finishedOnboardingOnAndroid: async () => false,
}));
jest.mock('../auth/emailVerification', () => ({ needsEmailVerification: () => false }));
jest.mock('../auth/backPress', () => ({ handleAuthBack: () => false }));
jest.mock('../PlanContent', () => ({ PlanContent: () => null }));
jest.mock('@/lib/superwall', () => ({ SUPERWALL_PLACEMENTS: {} }));
jest.mock('../onboarding/DeviceSetupScreens', () => ({
  DeviceSetupScreen: () => null,
  DeviceReadyScreen: () => null,
}));
jest.mock('@/screens/AuthScreen.android', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/store/useAuthStore', () => {
  const user = { isAnonymous: false, emailVerified: true };
  const store = (select: (state: object) => unknown) => select({ user });
  store.getState = () => ({ user, ensureAnonymousSession: jest.fn() });
  return { useAuthStore: store };
});
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({
    config: { languages: ['en'] },
    error: null,
    updateConfig: async () => undefined,
  })),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
jest.mock('../onboarding/setup', () => ({
  privateSupported: () => true,
  applyCloudConfig: async () => undefined,
  applyPrivateConfig: async () => undefined,
}));
const mockSaved = { step: 'mode' };
jest.mock('../onboarding/flow', () => ({
  ...jest.requireActual('../onboarding/flow'),
  savedStep: () => mockSaved.step,
  savedMode: () => 'cloud',
  savedReturning: () => false,
  saveProgress: jest.fn(),
  clearProgress: jest.fn(),
}));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import { Onboarding } from '../Onboarding';
import { GLASS_GRADIENT, Screen, GlassButton } from '../onboarding/kit';
import { PracticeBubble } from '../onboarding/PracticeBubble';
import { PracticeMenu } from '../onboarding/practiceParts';
import { PitchScreen } from '../onboarding/IntroScreens';
import { AccessibilityScreen } from '../onboarding/PermissionScreens';

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

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

const textColour = (text: string) => flat(screen.getByText(text).props.style).color;
/** The nearest host view above [node] with a background. */
function fillOf(node: ReactTestInstance) {
  for (let n: ReactTestInstance | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}
const page = () =>
  flat(screen.UNSAFE_root.findAll((n: ReactTestInstance) => n.props.edges)[0].props.style);

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockNavBar.mockClear();
  mockSaved.step = 'mode';
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('onboarding in %s', (scheme, tokens) => {
  it('draws the page, title and body from the palette; the glass button stays brand blue', () => {
    inTheme(scheme, () => (
      <Screen onBack={jest.fn()} footer={<GlassButton label="go" onPress={jest.fn()} />}>
        <></>
      </Screen>
    ));
    expect(page()).toMatchObject({ backgroundColor: tokens.canvas });
    expect(screen.getByTestId('glyph-ChevronLeft').props.accessibilityHint).toBe(tokens.ink);
    expect(screen.getByTestId('gradient').props.accessibilityHint).toBe(GLASS_GRADIENT.join(' '));
    expect(textColour('go')).toBe(tokens.onGlass);
  });

  it('Mode: the cards, ticks and words follow the scheme', () => {
    mockSaved.step = 'mode';
    inTheme(scheme, () => <Onboarding onFinish={jest.fn()} />);
    expect(page()).toMatchObject({ backgroundColor: tokens.canvas });
    expect(textColour('cloudName')).toBe(tokens.ink);
    expect(textColour('cloudPoint1')).toBe(tokens.secondary);
    expect(fillOf(screen.getByText('cloudName'))).toBe(tokens.surface);
    expect(mockNavBar).toHaveBeenLastCalledWith(tokens.canvas);
  });

  it('Accessibility permission: the setting cards and the step numbers', () => {
    inTheme(scheme, () => <AccessibilityScreen onBack={jest.fn()} onNext={jest.fn()} />);
    // The art is hidden from TalkBack (the step titles say it).
    const row = screen.getByText('accessibilityStep2On', { includeHiddenElements: true });
    expect(flat(row.props.style).color).toBe(tokens.ink);
    expect(fillOf(row)).toBe(tokens.surface);
    expect(textColour('accessibilityStep1')).toBe(tokens.ink);
    expect(fillOf(screen.getAllByText('1')[0])).toBe(tokens.accentSoft);
  });

  it('Accessibility: Continue opens the Play disclosure on the page colour; only Agree opens Settings', () => {
    const { AndroidDictation } = jest.requireMock('../../../modules/android-dictation/src');
    AndroidDictation.openSettings.mockClear();
    inTheme(scheme, () => <AccessibilityScreen onBack={jest.fn()} onNext={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'continue' }));
    expect(screen.getByText('disclosureTitle')).toBeTruthy();
    for (const key of [
      'disclosureReads',
      'disclosureFieldTitle',
      'disclosureSelectionBody',
      'disclosureFixesTitle',
      'disclosureAppTitle',
      'disclosurePasswordsTitle',
      'disclosureCloudBody',
    ])
      expect(screen.getByText(key)).toBeTruthy();
    expect(textColour('disclosureFieldTitle')).toBe(tokens.ink);
    fireEvent.press(screen.getByRole('button', { name: 'notNow' }));
    expect(AndroidDictation.openSettings).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'continue' }));
    fireEvent.press(screen.getByRole('button', { name: 'agreeAndOpen' }));
    expect(AndroidDictation.openSettings).toHaveBeenCalledWith('accessibility');
  });

  it('the practice menu draws its card, tiles and rows like the real hold menu', () => {
    inTheme(scheme, () => (
      <PracticeMenu
        target="assistant"
        language="Spanish"
        offsetX={16}
        onPick={jest.fn()}
        onClose={jest.fn()}
      />
    ));
    expect(textColour('menuAssistant')).toBe(tokens.ink);
    expect(textColour('menuTranslateBody')).toBe(tokens.secondary);
    const live = screen.getByText('menuAssistant').parent?.parent?.parent as ReactTestInstance;
    expect(fillOf(live)).toBe(tokens.selFill);
  });

  it('the practice bubble keeps its own colours; only its ✕ follows the theme (K7)', () => {
    inTheme(scheme, () => (
      <PracticeBubble
        state="listening"
        badge="sparkle"
        onPress={jest.fn()}
        onStop={jest.fn()}
        onCancel={jest.fn()}
      />
    ));
    const cancel = screen.getByRole('button', { name: 'cancelLabel' });
    expect(flat(cancel.props.style)).toMatchObject({ backgroundColor: tokens.surface });
    expect(screen.getByTestId('glyph-X').props.accessibilityHint).toBe(tokens.ink);
    expect(screen.getByTestId('gradient').props.accessibilityHint).toBe(GLASS_GRADIENT.join(' '));
  });

  it('the blue pitch card looks the same in both schemes (§3.7)', () => {
    inTheme(scheme, () => <PitchScreen onBack={jest.fn()} onNext={jest.fn()} />);
    const card = screen.getAllByTestId('gradient')[0];
    expect(card.props.accessibilityHint).toBe(
      [lightTheme.brandLight, lightTheme.accent, lightTheme.brandDeep].join(' '),
    );
    expect(textColour('pitch')).toBe(lightTheme.onGlass);
  });
});

describe('a light/dark switch mid-onboarding (§3b)', () => {
  it('keeps the step, the screen and what was picked, and repaints in place', async () => {
    mockSaved.step = 'mode';
    const tree = () => <Onboarding onFinish={jest.fn()} />;
    const { rerender } = inTheme('light', tree);
    fireEvent.press(screen.getByRole('radio', { name: 'privateName. privateBody' }));
    const title = screen.getByText('cloudName');
    expect(screen.getByRole('radio', { name: 'privateName. privateBody' }).props).toMatchObject({
      accessibilityState: { selected: true },
    });

    await switchTo('dark', rerender, tree);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('cloudName')).toBe(title);
    expect(textColour('cloudName')).toBe(darkTheme.ink);
    expect(page()).toMatchObject({ backgroundColor: darkTheme.canvas });
    expect(screen.getByRole('radio', { name: 'privateName. privateBody' }).props).toMatchObject({
      accessibilityState: { selected: true },
    });
    expect(mockNavBar).toHaveBeenLastCalledWith(darkTheme.canvas);

    await switchTo('light', rerender, tree);
    expect(screen.getByText('cloudName')).toBe(title);
    expect(textColour('cloudName')).toBe(lightTheme.ink);
    expect(mockNavBar).toHaveBeenLastCalledWith(lightTheme.canvas);
  });

  it('a step reached after the switch stays where it was across the next one', async () => {
    mockSaved.step = 'languages';
    const tree = () => <Onboarding onFinish={jest.fn()} />;
    const { rerender } = inTheme('dark', tree);
    fireEvent.press(screen.getByRole('button', { name: 'continue' }));
    // Languages → Apps.
    expect(screen.getByText('appsTitle')).toBeTruthy();
    await switchTo('light', rerender, tree);
    expect(screen.getByText('appsTitle')).toBeTruthy();
    expect(page()).toMatchObject({ backgroundColor: lightTheme.canvas });
  });
});

describe('the practice keyboard across a light/dark switch (§3b)', () => {
  const { Appearance, Keyboard } = require('react-native');
  const { KEYBOARD_RESTART_MS, useKeyboardAnchor } = require('../onboarding/practiceParts');

  function listen() {
    const keyboard: Record<string, () => void> = {};
    let appearance = () => undefined as void;
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, fn: () => void) => {
      keyboard[event] = fn;
      return { remove: jest.fn() };
    }) as never);
    jest.spyOn(Appearance, 'addChangeListener').mockImplementation(((fn: () => void) => {
      appearance = fn;
      return { remove: jest.fn() };
    }) as never);
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    const onHide = jest.fn();
    function Probe() {
      useKeyboardAnchor(onHide);
      return null;
    }
    render(<Probe />);
    return { keyboard, switchTheme: () => appearance(), onHide };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a keyboard closing on its own still leaves the box', () => {
    const { keyboard, onHide } = listen();
    keyboard.keyboardDidHide();
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('the keyboard restarting after a switch keeps the box focused', () => {
    const { keyboard, switchTheme, onHide } = listen();
    switchTheme();
    keyboard.keyboardDidHide();
    (Keyboard.isVisible as jest.Mock).mockReturnValue(true);
    act(() => jest.advanceTimersByTime(KEYBOARD_RESTART_MS + 100));
    expect(onHide).not.toHaveBeenCalled();
  });

  it('a keyboard still gone once the restart time is up does leave the box', () => {
    const { keyboard, switchTheme, onHide } = listen();
    switchTheme();
    keyboard.keyboardDidHide();
    expect(onHide).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(KEYBOARD_RESTART_MS + 100));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
