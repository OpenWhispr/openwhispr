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
let painted: number | null = null;
function paint(color: number | null) {
  if (color === painted) return;
  painted = color;
  setNavigationBarColor(color);
}

/**
 * Paints the button bar in `canvas` with dark icons and no contrast scrim while the calling
 * screen is focused; gesture navigation keeps the system's own handle.
 */
export function useNavigationBarCanvas(canvas: string) {
  const { buttons } = useNavigationBar();
  useFocusEffect(
    useCallback(() => {
      owners += 1;
      // A signed 32-bit ARGB int, as Android's Color is.
      paint(buttons ? (processColor(canvas) as number) | 0 : null);
      return () => {
        owners -= 1;
        // Counted, so moving between Settings screens never hands the bar back in between.
        if (!owners) paint(null);
      };
    }, [buttons, canvas]),
  );
}
