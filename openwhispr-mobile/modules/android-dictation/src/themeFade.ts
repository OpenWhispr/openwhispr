import { AndroidDictation } from './index';

// Kept out of index.ts, which the iOS bundle loads: only Android's ThemeProvider imports this.
type Native = {
  prepareThemeFade?: () => Promise<boolean>;
  fadeTheme?: (durationMs: number) => Promise<void>;
};
const native = AndroidDictation as Native | null;

/**
 * Freezes the screen as it is now: a copy of the window's last frame drawn over everything, so
 * the switch to the other palette happens under it. True once the copy is up; false without
 * native support or when the copy failed (the switch then happens without a fade).
 */
export function prepareThemeFade(): Promise<boolean> {
  const prepare = native?.prepareThemeFade;
  if (!prepare) return Promise.resolve(false);
  return prepare.call(native).catch(() => false);
}

/** Fades the frozen copy out over the repainted screen, then removes it. */
export function fadeTheme(durationMs: number): void {
  native?.fadeTheme?.call(native, durationMs)?.catch(() => undefined);
}
