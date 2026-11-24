import type { TextProps, TextStyle } from 'react-native';
import { useTheme, type AndroidTheme } from './ThemeProvider';

/** Figma "Android · Main navigation", option A: the bar is 80 dp above the system inset. */
export const TAB_BAR_HEIGHT = 80;
/** Labels follow the system font size up to this and then stop growing. */
export const TAB_LABEL_MAX_FONT_SCALE = 1.3;
/** Toasts and snackbars float this far above the bar. */
export const TAB_TOAST_GAP = 16;

type NestedState = { index?: number; routes: { name: string }[] };
export type TabRoute = {
  name: string;
  params?: object;
  state?: NestedState;
};

/** Screens that keep the bar: each tab's index, and a Notes folder (Figma L1b). */
const BAR_SCREENS = new Set(['index', 'notes']);

/**
 * The one rule for when the bar shows: the focused tab is on its index screen (or a Notes
 * folder). Every other pushed screen (a note, Actions, voice profiles, a recorder) hides it
 * without being listed here.
 */
export function isOnTabRoot(route: TabRoute): boolean {
  const nested = route.state;
  if (!nested?.routes.length) {
    // Before the tab's stack mounts, a navigate() into it names its target screen in params.
    const screen = (route.params as { screen?: unknown } | undefined)?.screen;
    return screen === undefined || (typeof screen === 'string' && BAR_SCREENS.has(screen));
  }
  const index = nested.index ?? nested.routes.length - 1;
  return BAR_SCREENS.has(nested.routes[index]?.name ?? '');
}

export function shouldShowTabBar({
  route,
  keyboardShown,
  hiddenByOptions,
}: {
  route: TabRoute;
  keyboardShown: boolean;
  /** A screen set `tabBarStyle: { display: 'none' }`. */
  hiddenByOptions: boolean;
}): boolean {
  return !hiddenByOptions && !keyboardShown && isOnTabRoot(route);
}

/** Space Grotesk 12, Bold when selected and Medium otherwise; one line, never shrunk. */
export function tabLabelProps(
  selected: boolean,
  theme: AndroidTheme,
): Pick<TextProps, 'numberOfLines' | 'maxFontSizeMultiplier' | 'adjustsFontSizeToFit'> & {
  style: TextStyle;
} {
  return {
    numberOfLines: 1,
    maxFontSizeMultiplier: TAB_LABEL_MAX_FONT_SCALE,
    adjustsFontSizeToFit: false,
    style: {
      fontFamily: selected ? 'SpaceGrotesk_700Bold' : 'SpaceGrotesk_500Medium',
      fontSize: 12,
      lineHeight: 16,
      color: selected ? theme.tokens.ink : theme.tokens.secondary,
      textAlign: 'center',
    },
  };
}

/** The bar's colours: white with a hairline on top in light, one step above the page in dark (K2). */
export function tabColorsFor(theme: AndroidTheme) {
  return {
    bar: theme.tokens.tabBar,
    hairline: theme.tokens.divider,
    pill: theme.tokens.selFill,
    iconSelected: theme.tokens.accent,
    icon: theme.tokens.secondary,
  };
}

/** The bar's colours for the scheme in use (`tabColorsFor`). */
export function useTabColors() {
  return tabColorsFor(useTheme());
}
