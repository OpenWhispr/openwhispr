import { themeFor, useTheme } from '@/android/ThemeProvider';
import type { Scheme } from '@/android/theme';

const upstream: typeof import('./colors') = require('./colors.ts');

export const { BRAND, BRAND_GRADIENT, CHAT_COLORS } = upstream;

/**
 * Android's page is the glossy white canvas (`src/android/theme`), not iOS's warm one. Only the
 * shared screens read this constant, and Android renders none of them; Android files read the
 * scheme in use through `useIosColor()`.
 */
export const APP_BACKGROUND = themeFor('light').tokens.canvas;

/** The system colours Android draws differently from iOS's fallbacks, per scheme. */
function overrides(scheme: Scheme): Record<string, string> {
  const k = themeFor(scheme).tokens;
  if (scheme === 'light')
    return {
      secondaryLabel: '#69666F',
      tertiaryLabel: '#737078',
      tertiarySystemBackground: k.surface,
      systemBackground: k.canvas,
    };
  // Dark (design §1): every system colour an Android file asks for maps onto a dark token.
  return {
    label: k.ink,
    secondaryLabel: k.secondary,
    tertiaryLabel: k.tertiary,
    quaternaryLabel: k.disabled,
    systemBackground: k.canvas,
    secondarySystemBackground: k.surface,
    tertiarySystemBackground: k.surface,
    secondarySystemGroupedBackground: k.surface,
    tertiarySystemFill: k.track,
    quaternarySystemFill: k.tile,
    separator: k.divider,
    link: k.accent,
    systemBlue: k.accent,
    systemRed: k.error,
    systemGreen: k.success,
    systemOrange: k.warning,
    systemGray2: k.dotIdle,
  };
}

const tables: Partial<Record<Scheme, Record<string, string>>> = {};

/** A system colour by its iOS name, for a scheme (light unless one is given). */
export function iosColor(name: string, scheme: Scheme = 'light'): string {
  const table = (tables[scheme] ??= overrides(scheme));
  return table[name] ?? upstream.iosColor(name);
}

/**
 * `iosColor` for the scheme in use. Read it at render, as `const color = useIosColor()` then
 * `color('label')`, so a light/dark switch repaints in place (dark design §3b).
 */
export function useIosColor(): (name: string) => string {
  const { scheme } = useTheme();
  return (name: string) => iosColor(name, scheme);
}
