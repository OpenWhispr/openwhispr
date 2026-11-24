import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { fadeTheme, prepareThemeFade } from '../../modules/android-dictation/src/themeFade';
import { recipes, tokens, type Recipes, type Scheme, type ThemeTokens } from './theme';

/** What `useTheme()` gives a screen: the scheme, its palette and its surface recipes. */
export interface AndroidTheme extends Recipes {
  scheme: Scheme;
  tokens: ThemeTokens;
}

function build(scheme: Scheme): AndroidTheme {
  return { scheme, tokens: tokens(scheme), ...recipes(scheme) };
}

/** Built once per scheme, so a screen's styles and memo inputs stay stable between renders. */
const THEMES: Record<Scheme, AndroidTheme> = { light: build('light'), dark: build('dark') };

/** The theme for a scheme, for code outside React (and tests). */
export function themeFor(scheme: Scheme): AndroidTheme {
  return THEMES[scheme];
}

// Outside a provider (a test rendering one screen, a headless task) screens get light.
const ThemeContext = createContext<AndroidTheme>(THEMES.light);

/** The fade over a switch (design §3b): one short crossfade of the whole frame, ~200 ms. */
export const THEME_FADE_MS = 200;
/** Never wait longer than this for the native copy of the frame; switch without a fade instead. */
export const THEME_PREPARE_TIMEOUT_MS = 250;

function frozen(): Promise<boolean> {
  return Promise.race([
    prepareThemeFade(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), THEME_PREPARE_TIMEOUT_MS)),
  ]);
}

/**
 * Follows the system's light or dark setting (decision K7/§3), or `override` once a manual
 * setting exists (K8). A switch never remounts anything: the native side freezes the current
 * frame, the tree re-renders in place in the new palette under it, and the frozen copy fades out.
 * Navigation, scroll, sheets, typing, focus and running work are untouched.
 */
export function ThemeProvider({ children, override }: { children: ReactNode; override?: Scheme }) {
  const system: Scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const wanted = override ?? system;
  const [scheme, setScheme] = useState<Scheme>(wanted);
  const target = useRef(wanted);
  const fading = useRef(false);

  useEffect(() => {
    target.current = wanted;
    if (wanted === scheme) return;
    let current = true;
    void frozen().then((ready) => {
      // A switch straight back (or a newer one) leaves this one behind.
      if (!current || target.current !== wanted) return;
      fading.current = ready;
      setScheme(wanted);
    });
    return () => {
      current = false;
    };
  }, [wanted, scheme]);

  useEffect(() => {
    if (!fading.current) return;
    fading.current = false;
    // Two frames: the new palette is committed, mounted and drawn before the copy starts fading.
    let pending = true;
    const fade = () => {
      pending = false;
      fadeTheme(THEME_FADE_MS);
    };
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(fade);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      // Cut short before it faded (unmounted): the copy still goes.
      if (pending) fade();
    };
  }, [scheme]);

  return <ThemeContext.Provider value={THEMES[scheme]}>{children}</ThemeContext.Provider>;
}

/** The theme in use. Read it at render; never copy a colour into a module-level constant. */
export function useTheme(): AndroidTheme {
  return useContext(ThemeContext);
}

/**
 * A `StyleSheet` built from the theme, once per scheme:
 * `const useStyles = makeStyles((t) => ({ card: { ...t.flat, padding: 16 } }))`, then
 * `const styles = useStyles()` inside the component.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: AndroidTheme) => T,
): () => T {
  const sheets: Partial<Record<Scheme, T>> = {};
  return function useStyles() {
    const theme = useTheme();
    return (sheets[theme.scheme] ??= StyleSheet.create(factory(theme)));
  };
}
