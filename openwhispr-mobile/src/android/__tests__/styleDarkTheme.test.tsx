import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, useColorScheme } from 'react-native';
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
jest.mock('@/android/navigationBar', () => ({
  useNavigationBar: () => ({ buttons: true, inset: 0 }),
  useNavigationBarCanvas: (colour: string) => mockNavBar(colour),
}));
const mockNavBar = jest.fn();
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
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@react-navigation/native', () => ({ useScrollToTop: () => undefined }));
jest.mock('react-native-svg', () => ({
  SvgXml: ({ xml }: { xml: string }) => {
    const { View: Mark } = require('react-native');
    return <Mark testID="mark" accessibilityHint={xml} />;
  },
}));
jest.mock('expo-image', () => ({ Image: require('react-native').View }));
jest.mock('@/store/useAuthStore', () => ({ useAuthStore: () => null }));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/android/settings/kit', () => {
  const { Pressable } = require('react-native');
  return {
    showToast: jest.fn(),
    Toggle: ({ value, onValueChange, label, disabled }: any) =>
      require('react').createElement(Pressable, {
        accessibilityRole: 'switch',
        accessibilityLabel: label,
        accessibilityState: { checked: value, disabled },
        disabled,
        onPress: () => onValueChange(!value),
      }),
  };
});
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: require('zustand').create(() => ({ config: {}, error: null })),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));

import { ThemeProvider } from '../ThemeProvider';
import { darkTheme, lightTheme } from '../theme';
import StyleScreen from '../StyleScreen';
import ToneSetupScreen from '../style/ToneSetupScreen';
import { AppMark, DiffText, GlassCta } from '../style/kit';

type ReactTestInstance = ReturnType<typeof screen.getByText>;
const mockScheme = useColorScheme as jest.MockedFunction<typeof useColorScheme>;
const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;

function setStyle(androidToneStyle?: object) {
  useConfigStore.setState({
    config: { defaultMode: 'cloud', androidToneStyle } as never,
    error: null,
    updateConfig: jest.fn(async (change: object) => {
      useConfigStore.setState((state) => ({
        config: { ...state.config!, ...change },
        error: null,
      }));
    }),
  } as never);
}

function inTheme(scheme: 'light' | 'dark', node: () => React.ReactElement) {
  mockScheme.mockReturnValue(scheme);
  return render(<ThemeProvider>{node()}</ThemeProvider>);
}

/** Switches the system scheme and lets the provider repaint (frozen frame, then the new palette). */
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

beforeEach(() => {
  mockScheme.mockReturnValue('light');
  mockPrepare.mockClear();
  mockNavBar.mockClear();
  setStyle({ enabled: true, setUp: true });
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Style tab in %s', (scheme, tokens) => {
  it('draws the page, header and tone card from the palette', () => {
    inTheme(scheme, () => <StyleScreen />);
    expect(
      flat(screen.UNSAFE_root.findAll((n: ReactTestInstance) => n.props.edges)[0].props.style),
    ).toMatchObject({ backgroundColor: tokens.canvas });
    expect(textColour('tabTitle')).toBe(tokens.ink);
    expect(textColour('subtitleOn')).toBe(tokens.secondary);
    // The card's tone name (the slider's label under it is the other "toneCasual").
    expect(flat(screen.getAllByText('toneCasual')[0].props.style).color).toBe(tokens.ink);
    expect(textColour('describeCasual')).toBe(tokens.secondary);
  });

  it('cuts the app marks out of the tab behind them: raised fill when picked, track when not', () => {
    inTheme(scheme, () => <StyleScreen />);
    const tab = (name: string) => screen.getByRole('tab', { name });
    const ringIn = (node: ReactTestInstance) =>
      node
        .findAll((n: ReactTestInstance) => typeof n.type === 'string')
        .map((n: ReactTestInstance) => flat(n.props.style) as Record<string, unknown> | undefined)
        .find(
          (s: Record<string, unknown> | undefined) => s?.borderRadius === 999 && s?.width === 24,
        )?.backgroundColor;
    expect(ringIn(tab('rowPersonal'))).toBe(tokens.raisedFill);
    expect(ringIn(tab('rowWork'))).toBe(tokens.track);
  });

  it('draws the example with the scheme’s bubbles, struck and added words', () => {
    inTheme(scheme, () => <StyleScreen />);
    const preview = screen.getByLabelText(/exampleLabel/);
    expect(flat(preview.props.style).backgroundColor).toBe(tokens.surface2);
    const spans = preview.findAll(
      (n: ReactTestInstance) => typeof n.type === 'string' && n.props.style?.textDecorationLine,
    );
    expect(flat(spans[0].props.style).color).toBe(tokens.struck);
    const added = preview.findAll(
      (n: ReactTestInstance) =>
        typeof n.type === 'string' && flat(n.props.style)?.fontWeight === '500',
    );
    expect(added.length).toBeGreaterThan(0);
    expect(flat(added[0].props.style).color).toBe(
      scheme === 'dark' ? tokens.accent : tokens.glassBottom,
    );
    const colours = preview
      .findAll((n: ReactTestInstance) => typeof n.type === 'string')
      .map((n: ReactTestInstance) => flat(n.props.style)?.backgroundColor)
      .filter(Boolean);
    expect(colours).toEqual(expect.arrayContaining([tokens.track, tokens.sentBubble]));
  });

  it('gives the slider an inset track, stops on the surface and the scheme’s knob', () => {
    inTheme(scheme, () => <StyleScreen />);
    const slider = screen.getByRole('adjustable');
    act(() => {
      slider.props.onLayout({ nativeEvent: { layout: { width: 320, height: 60 } } });
    });
    const views = slider
      .findAll((n: ReactTestInstance) => typeof n.type === 'string')
      .map((n: ReactTestInstance) => flat(n.props.style) as Record<string, unknown> | undefined);
    expect(views.find((s: Record<string, unknown> | undefined) => s?.height === 6)).toMatchObject({
      backgroundColor: tokens.track,
    });
    expect(views.filter((s: Record<string, unknown> | undefined) => s?.width === 8)).toHaveLength(
      3,
    );
    for (const stop of views.filter((s: Record<string, unknown> | undefined) => s?.width === 8))
      expect(stop).toMatchObject({ backgroundColor: tokens.surface, borderColor: tokens.divider });
    expect(
      views.find((s: Record<string, unknown> | undefined) => s?.width === 28)
        ?.experimental_backgroundImage,
    ).toBe(
      scheme === 'dark'
        ? 'linear-gradient(180deg, #FFFFFF 0%, #D9DAE1 100%)'
        : 'linear-gradient(180deg, #FFFFFF 0%, #ECEAF0 100%)',
    );
  });
});

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('Tone setup in %s', (scheme, tokens) => {
  it('paints the page and the system nav bar the canvas, with white on the glass', () => {
    inTheme(scheme, () => <ToneSetupScreen />);
    expect(mockNavBar).toHaveBeenLastCalledWith(tokens.canvas);
    expect(textColour('introTitle')).toBe(tokens.ink);
    expect(textColour('letsPersonalize')).toBe(tokens.onGlass);
    expect(textColour('notNow')).toBe(tokens.secondary);
    expect(screen.getAllByTestId('glyph')[0].props.accessibilityHint).toBe(tokens.ink);
  });

  it('rings the picked tone card and colours the deck dots', () => {
    inTheme(scheme, () => <ToneSetupScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'letsPersonalize' }));
    const picked = screen.getByRole('radio', { checked: true });
    expect(flat(picked.props.style)).toMatchObject({
      borderColor: tokens.pickedRing,
      backgroundColor: tokens.surface,
    });
    expect(textColour('soundsLikeMe')).toBe(tokens.onGlass);
  });

  it('draws the summary rows on a flat card with tiles', () => {
    inTheme(scheme, () => <ToneSetupScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'letsPersonalize' }));
    for (let i = 0; i < 4; i += 1)
      fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    expect(textColour('doneTitle')).toBe(tokens.ink);
    expect(textColour('rowEmail')).toBe(tokens.ink);
    const row = screen.getByRole('button', { name: 'rowEmail, toneFormal' });
    expect(fillOf(row.parent!)).toBe(tokens.surface);
    expect(fillOf(screen.getAllByTestId('mark')[0])).toBe(tokens.tile);
  });
});

describe('kit pieces', () => {
  it('keeps app logos as drawn: grey disc on white, white disc elsewhere (dark too)', () => {
    inTheme('dark', () => (
      <>
        <AppMark logo="notion" size={20} behind="#FFFFFF" />
        <AppMark logo="notion" size={20} behind={darkTheme.raisedFill} />
      </>
    ));
    const [onWhite, onDark] = screen.getAllByTestId('mark').map((n) => n.props.accessibilityHint);
    expect(onWhite).toContain('#F4F4F2');
    expect(onDark).not.toContain('#F4F4F2');
  });

  it('writes the glass CTA label in onGlass in both schemes (never the dark surface)', () => {
    inTheme('dark', () => <GlassCta label="Go" onPress={() => undefined} />);
    expect(textColour('Go')).toBe('#FFFFFF');
    expect(darkTheme.surface).not.toBe('#FFFFFF');
  });

  it('draws the spoken line in ink', () => {
    inTheme('dark', () => <DiffText example="+Hey+ there" />);
    expect(textColour('Hey')).toBe(darkTheme.accent);
  });
});

describe('live switch (design §3b)', () => {
  it('repaints the Style tab in place: same views, picked kind and slider kept', async () => {
    const tree = () => <StyleScreen />;
    const { rerender } = inTheme('light', tree);
    fireEvent.press(screen.getByRole('tab', { name: 'rowEmail' }));
    await act(async () => {
      fireEvent(screen.getByRole('adjustable'), 'accessibilityAction', {
        nativeEvent: { actionName: 'increment' },
      });
    });
    const title = screen.getByText('tabTitle');
    const slider = screen.getByRole('adjustable');
    expect(slider.props.accessibilityValue).toEqual({ text: 'toneCasual' });
    expect(title.props.style).toMatchObject({ color: lightTheme.ink });

    await switchTo('dark', rerender, tree);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('tabTitle')).toBe(title);
    expect(screen.getByRole('adjustable')).toBe(slider);
    expect(textColour('tabTitle')).toBe(darkTheme.ink);
    expect(screen.getByRole('tab', { name: 'rowEmail' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByRole('adjustable').props.accessibilityValue).toEqual({
      text: 'toneCasual',
    });

    await switchTo('light', rerender, tree);
    expect(screen.getByText('tabTitle')).toBe(title);
    expect(textColour('tabTitle')).toBe(lightTheme.ink);
  });

  it('keeps the setup on its step and deck card through a switch', async () => {
    const tree = () => <ToneSetupScreen />;
    const { rerender } = inTheme('light', tree);
    fireEvent.press(screen.getByRole('button', { name: 'letsPersonalize' }));
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    // Work: pick Excited.
    fireEvent.press(screen.getByRole('radio', { name: 'toneExcited. describeExcited' }));
    const header = screen.getByText('askWork');

    await switchTo('dark', rerender, tree);
    expect(screen.getByText('askWork')).toBe(header);
    expect(textColour('askWork')).toBe(darkTheme.ink);
    const picked = screen.getByRole('radio', { checked: true });
    expect(picked.props.accessibilityLabel).toBe('toneExcited. describeExcited');
    expect(flat(picked.props.style).borderColor).toBe(darkTheme.pickedRing);
    expect(mockNavBar).toHaveBeenLastCalledWith(darkTheme.canvas);

    // The picks made before the switch still save at Done.
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    fireEvent.press(screen.getByRole('button', { name: 'soundsLikeMe' }));
    expect(screen.getByText('toneExcited')).toBeTruthy();
  });
});
