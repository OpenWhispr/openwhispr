import { EventEmitter } from 'expo';
import { AndroidDictation } from './index';

// Kept out of index.ts, which the iOS bundle loads: only Android screens import this.
export interface NativeNavigationBar {
  /** False before the window has insets. */
  known: boolean;
  /** Two or three buttons (the bottom tappable-element inset is above 0); false with gestures. */
  buttons: boolean;
  /** The tappable-element inset in dp: 0 with gestures, about 48 with buttons. */
  bottom: number;
}

type Native = {
  getNavigationBar?: () => Promise<NativeNavigationBar>;
  setNavigationBarColor?: (color: number | null, darkIcons?: boolean) => Promise<void>;
};
const native = AndroidDictation as Native | null;

/** Undefined on native builds before navigation-bar support. */
export const getNavigationBar = native?.getNavigationBar?.bind(native);

/**
 * A colour paints the bar as part of the page, with dark icons on a light page and light icons on
 * a dark one; null puts back the window's own look.
 */
export function setNavigationBarColor(color: number | null, darkIcons = true): void {
  native?.setNavigationBarColor?.(color, darkIcons)?.catch(() => undefined);
}

export const navigationBarEvents = native?.getNavigationBar
  ? new EventEmitter<{ onNavigationBarChange: (state: NativeNavigationBar) => void }>(
      AndroidDictation as never,
    )
  : null;
