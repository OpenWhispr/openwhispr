import {
  isOnTabRoot,
  shouldShowTabBar,
  tabColorsFor,
  tabLabelProps,
  TAB_LABEL_MAX_FONT_SCALE,
} from '../tabBar';
import { themeFor } from '../ThemeProvider';

jest.mock('../../../modules/android-dictation/src/themeFade', () => ({
  prepareThemeFade: jest.fn(async () => false),
  fadeTheme: jest.fn(),
}));

const light = themeFor('light');
const dark = themeFor('dark');

const stack = (...names: string[]) => ({
  name: '(notes)',
  state: { index: names.length - 1, routes: names.map((name) => ({ name })) },
});

describe('when the bar shows', () => {
  it('shows on a tab whose stack has not mounted yet', () => {
    expect(isOnTabRoot({ name: '(record)' })).toBe(true);
  });

  it('shows on the index screen of a tab', () => {
    expect(isOnTabRoot(stack('index'))).toBe(true);
  });

  it.each(['[id]', 'actions', 'meeting-record', 'import-audio', 'voice-profiles', 'voice-profile'])(
    'hides on the pushed screen %s, and on any screen not yet invented',
    (screen) => {
      expect(isOnTabRoot(stack('index', screen))).toBe(false);
    },
  );

  it('keeps the bar inside a Notes folder (Figma L1b)', () => {
    expect(isOnTabRoot(stack('index', 'notes'))).toBe(true);
    expect(isOnTabRoot(stack('index', 'notes', '[id]'))).toBe(false);
    expect(isOnTabRoot({ name: '(notes)', params: { screen: 'notes' } })).toBe(true);
  });

  it('comes back after popping to the first screen', () => {
    expect(
      isOnTabRoot({
        ...stack('index', '[id]'),
        state: { ...stack('index', '[id]').state, index: 0 },
      }),
    ).toBe(true);
  });

  it('hides when a deep link opens a stack on a pushed screen only', () => {
    expect(isOnTabRoot(stack('[id]'))).toBe(false);
  });

  it('reads the last route of a partial state with no index', () => {
    expect(
      isOnTabRoot({ name: '(notes)', state: { routes: [{ name: 'index' }, { name: '[id]' }] } }),
    ).toBe(false);
  });

  it('follows a navigate() target before the stack mounts', () => {
    expect(isOnTabRoot({ name: '(notes)', params: { screen: '[id]' } })).toBe(false);
    expect(isOnTabRoot({ name: '(notes)', params: { screen: 'index' } })).toBe(true);
  });

  it('hides while the keyboard is up', () => {
    expect(
      shouldShowTabBar({ route: stack('index'), keyboardShown: true, hiddenByOptions: false }),
    ).toBe(false);
  });

  it("respects a screen's tabBarStyle display: 'none'", () => {
    expect(
      shouldShowTabBar({ route: stack('index'), keyboardShown: false, hiddenByOptions: true }),
    ).toBe(false);
  });

  it('shows on a tab root with the keyboard down', () => {
    expect(
      shouldShowTabBar({ route: stack('index'), keyboardShown: false, hiddenByOptions: false }),
    ).toBe(true);
  });
});

describe('tab labels', () => {
  it('stay on one line and never shrink to fit', () => {
    for (const selected of [true, false]) {
      const props = tabLabelProps(selected, light);
      expect(props.numberOfLines).toBe(1);
      expect(props.adjustsFontSizeToFit).toBe(false);
    }
  });

  it('grow with the system font size up to 1.3x', () => {
    expect(TAB_LABEL_MAX_FONT_SCALE).toBe(1.3);
    expect(tabLabelProps(true, light).maxFontSizeMultiplier).toBe(1.3);
    expect(tabLabelProps(false, light).maxFontSizeMultiplier).toBe(1.3);
  });

  it('are Space Grotesk 12, Bold in text/primary when selected', () => {
    expect(tabLabelProps(true, light).style).toMatchObject({
      fontFamily: 'SpaceGrotesk_700Bold',
      fontSize: 12,
      color: '#21212B',
    });
    expect(tabLabelProps(true, dark).style.color).toBe('#F2F2F5');
  });

  it('are Space Grotesk 12 Medium in text/secondary when not selected', () => {
    expect(tabLabelProps(false, light).style).toMatchObject({
      fontFamily: 'SpaceGrotesk_500Medium',
      fontSize: 12,
      color: '#66636E',
    });
    expect(tabLabelProps(false, dark).style.color).toBe('#A2A2AD');
  });
});

describe('tab bar colours', () => {
  it('are white with a hairline in light (Josh, 18 Nov)', () => {
    expect(tabColorsFor(light)).toEqual({
      bar: '#FFFFFF',
      hairline: 'rgba(0,0,0,0.08)',
      pill: 'rgba(21,85,212,0.12)',
      iconSelected: '#1555D4',
      icon: '#66636E',
    });
  });

  it('sit one step above the page in dark (K2), with the lighter link blue (K5)', () => {
    expect(tabColorsFor(dark)).toEqual({
      bar: '#16171C',
      hairline: 'rgba(255,255,255,0.09)',
      pill: 'rgba(110,155,255,0.18)',
      iconSelected: '#6E9BFF',
      icon: '#A2A2AD',
    });
  });
});
