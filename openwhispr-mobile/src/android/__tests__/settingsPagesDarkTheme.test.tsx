import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet, useColorScheme } from 'react-native';
import { useConfigStore } from '@/store/useConfigStore';

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
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), canGoBack: () => true },
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
  SystemIcon: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="glyph" accessibilityHint={color} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native', () => ({
  useScrollToTop: () => undefined,
  useIsFocused: () => true,
}));
jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, Circle: View, Path: View, Rect: View, SvgXml: View };
});
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
// The bubble's own glyphs (reanimated) and the onboarding glass, stubbed: only the colours matter.
jest.mock('../onboarding/PracticeBubble', () => ({
  Glyph: ({ color }: { color: string }) => {
    const { View: Glyph } = require('react-native');
    return <Glyph testID="bubble-glyph" accessibilityHint={color} />;
  },
}));
jest.mock('../onboarding/kit', () => ({ GLASS_GRADIENT: ['#5588F0', '#3466E2'] }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: require('react-native').View }));
jest.mock('../calendar/connect', () => ({ needsReconnect: () => false }));
jest.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0 }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1' } },
}));
jest.mock('@/lib/openExternal', () => ({ openExternal: jest.fn(), openMail: jest.fn() }));
jest.mock('../../../modules/android-dictation/src/appearance', () => ({
  setBubbleAppearance: jest.fn(),
}));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: require('zustand').create(() => ({ activeMode: 'cloud' })),
}));
jest.mock('@/store/useCustomPromptsStore', () => ({
  useCustomPromptsStore: require('zustand').create(() => ({
    customPrompts: { cleanup: '' },
    setCustomPrompt: jest.fn(),
    resetCustomPrompt: jest.fn(),
  })),
}));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import CleanupPromptScreen from '../settings/CleanupPromptScreen';
import SizeLookScreen from '../settings/SizeLookScreen';
import BubbleAssistantScreen from '../settings/BubbleAssistantScreen';
import HelpScreen from '../HelpScreen';
import { AmberTag, GoogleTile } from '../settings/calendarParts';

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const textColour = (text: string) => flat(screen.getByText(text).props.style).color;
/** The nearest host view above [node] with a background. */
function fillOf(node: ReactTestInstance) {
  for (let n: ReactTestInstance | null = node; n; n = n.parent)
    if (typeof n.type === 'string' && flat(n.props.style)?.backgroundColor)
      return flat(n.props.style).backgroundColor;
  return undefined;
}

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
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockNavBar.mockClear();
  // Left pending: the screens run as with animations on, and no late state update lands.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(new Promise(() => {}));
  useConfigStore.setState({
    config: { cleanupEnabled: true, androidBubbleSize: 64 } as never,
    error: null,
  } as never);
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Settings pages in %s', (scheme, tokens) => {
  it('draws the cleanup prompt field, its label and caret from the palette', () => {
    inTheme(scheme, () => <CleanupPromptScreen />);
    expect(mockNavBar).toHaveBeenLastCalledWith(tokens.canvas);
    expect(textColour('promptIntro')).toBe(tokens.ink);
    expect(textColour('prompt')).toBe(tokens.secondary);
    const field = screen.getByLabelText('cleanupPrompt');
    expect(flat(field.props.style).color).toBe(tokens.ink);
    expect(field.props.selectionColor).toBe(tokens.selFill);
    expect(field.props.cursorColor).toBe(tokens.accent);
    expect(fillOf(field)).toBe(tokens.surface);
    fireEvent(field, 'focus');
    expect(fillOf(field)).toBe(tokens.surface);
    // The focused field's card takes the accent outline.
    let card: ReactTestInstance | null = screen.getByText('prompt').parent;
    while (card && !(typeof card.type === 'string' && flat(card.props.style)?.borderColor))
      card = card.parent;
    expect(flat(card!.props.style).borderColor).toBe(tokens.accent);
  });

  it('draws the Size & look preview and slider cards from the palette', () => {
    inTheme(scheme, () => <SizeLookScreen />);
    const preview = screen.getByLabelText('bubblePreview');
    expect(flat(preview.props.style).backgroundColor).toBe(tokens.selFill);
    expect(textColour('size')).toBe(tokens.ink);
    expect(textColour('small')).toBe(tokens.secondary);
    expect(fillOf(screen.getByText('size'))).toBe(tokens.surface);
  });

  it('draws the assistant preview menu on a flat card with the scheme’s tiles', () => {
    inTheme(scheme, () => <BubbleAssistantScreen />);
    const preview = screen.getByLabelText('assistantPreview');
    expect(flat(preview.props.style).backgroundColor).toBe(tokens.selFill);
    const fills = preview
      .findAll((n: ReactTestInstance) => typeof n.type === 'string')
      .map((n: ReactTestInstance) => flat(n.props.style)?.backgroundColor)
      .filter(Boolean);
    expect(fills).toEqual(expect.arrayContaining([tokens.surface, tokens.tile, tokens.onGlass]));
    // The bubble's own white badge stays white.
    expect(fills).toContain('#FFFFFF');
    expect(textColour('assistantSwitchBody')).toBe(tokens.secondary);
  });

  it('writes Help’s version line in the secondary grey', () => {
    inTheme(scheme, () => <HelpScreen />);
    expect(flat(screen.getByText(/version/).props.style).color).toBe(tokens.secondary);
  });

  it('draws the calendar tiles and the amber tag from the palette', () => {
    inTheme(scheme, () => (
      <>
        <GoogleTile />
        <AmberTag label="signedOut" />
      </>
    ));
    expect(textColour('signedOut')).toBe(tokens.amber);
    expect(fillOf(screen.getByText('signedOut'))).toBe(tokens.amberFill);
    expect(fillOf(screen.getByText('G'))).toBe(tokens.surface);
  });
});

describe('live switch (design §3b)', () => {
  it('repaints the cleanup prompt in place, keeping the typed text in the same field', async () => {
    const tree = () => <CleanupPromptScreen />;
    const { rerender } = inTheme('light', tree);
    const field = screen.getByLabelText('cleanupPrompt');
    fireEvent.changeText(field, 'Keep every word, just fix the commas.');
    expect(flat(field.props.style).color).toBe(lightTheme.ink);

    await switchTo('dark', rerender, tree);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('cleanupPrompt')).toBe(field);
    expect(field.props.value).toBe('Keep every word, just fix the commas.');
    expect(flat(field.props.style).color).toBe(darkTheme.ink);
    expect(field.props.cursorColor).toBe(darkTheme.accent);
    expect(mockNavBar).toHaveBeenLastCalledWith(darkTheme.canvas);

    await switchTo('light', rerender, tree);
    expect(screen.getByLabelText('cleanupPrompt')).toBe(field);
    expect(field.props.value).toBe('Keep every word, just fix the commas.');
    expect(flat(field.props.style).color).toBe(lightTheme.ink);
  });
});
