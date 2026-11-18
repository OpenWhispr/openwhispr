import type { TextProps, TextStyle } from 'react-native';
import { home } from './home/kit';

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

/**
 * The one rule for when the bar shows: the focused tab is on its index screen. Every pushed
 * screen (a note, Actions, voice profiles, a recorder) hides it without being listed here.
 */
export function isOnTabRoot(route: TabRoute): boolean {
  const nested = route.state;
  if (!nested?.routes.length) {
    // Before the tab's stack mounts, a navigate() into it names its target screen in params.
    const screen = (route.params as { screen?: unknown } | undefined)?.screen;
    return screen === undefined || screen === 'index';
  }
  const index = nested.index ?? nested.routes.length - 1;
  return nested.routes[index]?.name === 'index';
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
export function tabLabelProps(selected: boolean): Pick<
  TextProps,
  'numberOfLines' | 'maxFontSizeMultiplier' | 'adjustsFontSizeToFit'
> & {
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
      color: selected ? home.text : home.secondary,
      textAlign: 'center',
    },
  };
}

export const tabColors = {
  bar: home.canvas,
  pill: home.tint,
  iconSelected: home.accent,
  icon: home.secondary,
} as const;
