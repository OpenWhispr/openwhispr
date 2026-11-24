import { useCallback, useEffect } from 'react';
import { processColor } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import {
  getNavigationBar,
  navigationBarEvents,
  setNavigationBarColor,
  type NativeNavigationBar,
} from '../../modules/android-dictation/src/navigationBar';

/** Without native support, a bottom inset this tall (dp) means buttons rather than a handle. */
const BUTTONS_FALLBACK_DP = 40;

const useNative = create<NativeNavigationBar | null>(() => null);
let listening = false;
function listen() {
  if (listening || !getNavigationBar) return;
  listening = true;
  getNavigationBar()
    .then((state) => state.known && useNative.setState(state, true))
    .catch(() => undefined);
  navigationBarEvents?.addListener('onNavigationBarChange', (state) =>
    useNative.setState(state, true),
  );
}

/**
 * How the phone navigates: gestures (a thin handle over the content) or two or three buttons (a
 * bar the page should own). `inset` is the bottom system inset in dp, for spacing in both modes.
 * Updates live when someone switches in Android Settings.
 */
export function useNavigationBar(): { buttons: boolean; inset: number } {
  const native = useNative();
  const inset = useSafeAreaInsets().bottom;
  useEffect(listen, []);
  return { buttons: native ? native.buttons : inset >= BUTTONS_FALLBACK_DP, inset };
}

// Screens that want the bar painted as part of the page; the bar is restored when none is focused.
let owners = 0;
let painted: string | null = null;
function paint(color: number | null, darkIcons: boolean) {
  const key = color === null ? null : `${color}:${darkIcons}`;
  if (key === painted) return;
  painted = key;
  setNavigationBarColor(color, darkIcons);
}

/** Whether a page colour wants dark bar icons: anything lighter than mid grey. */
export function wantsDarkIcons(color: number): boolean {
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  return 0.299 * red + 0.587 * green + 0.114 * blue > 128;
}

/**
 * Paints the button bar in `canvas` with no contrast scrim while the calling screen is focused,
 * its icons dark on a light canvas and light on a dark one; gesture navigation keeps the system's
 * own handle. A screen on `useTheme()` passes its theme's canvas, so the bar switches in the same
 * render as the page.
 */
export function useNavigationBarCanvas(canvas: string) {
  const { buttons } = useNavigationBar();
  useFocusEffect(
    useCallback(() => {
      owners += 1;
      // A signed 32-bit ARGB int, as Android's Color is.
      const color = buttons ? (processColor(canvas) as number) | 0 : null;
      paint(color, color === null || wantsDarkIcons(color));
      return () => {
        owners -= 1;
        // Counted, so moving between Settings screens never hands the bar back in between.
        if (!owners) paint(null, true);
      };
    }, [buttons, canvas]),
  );
}
