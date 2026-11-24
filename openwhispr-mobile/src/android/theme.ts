import type { ViewStyle } from 'react-native';

/**
 * Android's one colour and surface source ("Glossy white" 3b, Figma page "🤖 Android · Glossy
 * white (exploration)", components board 5489:17090; dark: "🤖 Android · Dark theme (design)",
 * 5533:17158). Screens never write a hex of their own, except third-party logos.
 *
 * Two palettes with the same keys, `lightTheme` and `darkTheme`, and their surface recipes,
 * `recipes(scheme)`. Screens read the one in use at render through `useTheme()` or `makeStyles()`
 * (`ThemeProvider.tsx`), so a system switch repaints them in place. `theme` and the recipe exports
 * below are the light ones, for files not moved to `useTheme()` yet.
 */
export type Scheme = 'light' | 'dark';

export const lightTheme = {
  /** The page, sheets and the system navigation bar. */
  canvas: '#EFF0F2',
  /** Cards, rows, white buttons. */
  surface: '#FFFFFF',
  /** Previews and soft panels. */
  surface2: '#F7F8FA',
  /** Icon tiles, idle and pressed fills. */
  tile: '#F1F2F4',
  /** A switch that's off, a tab track, a progress track, a neutral badge, a sheet's grabber. */
  track: '#E6E7EB',
  /** Idle progress dots and steps. */
  trackStrong: '#DFE0E5',
  dotIdle: '#CDCFD5',
  disabled: '#BFC1C7',
  ink: '#21212B',
  secondary: '#66636E',
  tertiary: '#A1A1AA',
  /** Links and selected icons. The brand glass keeps its own two blues. */
  accent: '#1555D4',
  hairline: 'rgba(0,0,0,0.06)',
  divider: 'rgba(0,0,0,0.08)',
  /** A text field's hairline, a step darker than a card's. */
  fieldHairline: 'rgba(0,0,0,0.10)',
  /** A selected row or tile: the accent at 12%. */
  selFill: 'rgba(21,85,212,0.12)',
  /** The dark toast pill; `toastSolid` is the snackbar with an action. */
  toast: 'rgba(29,29,36,0.92)',
  toastSolid: '#1D1D24',
  /** Text and icons on the toast, its top rim, and its action word (Undo). */
  onToast: '#FFFFFF',
  toastRim: 'rgba(255,255,255,0.14)',
  toastAction: '#8FB2FF',
  /** Labels and icons on the brand glass. */
  onGlass: '#FFFFFF',
  /** Your own message bubble in an example (Style's previews). */
  sentBubble: '#E3EBFC',
  /** Words a tone drops, struck out in an example: the secondary grey at 45%. */
  struck: 'rgba(102,99,110,0.45)',
  /** The ring round a picked card (the tone setup's decks). */
  pickedRing: 'rgba(52,102,226,0.9)',
  /** Status colours: an error, a success, a warning (a signed-out calendar, a long prompt). */
  error: '#D70015',
  success: '#1F9D55',
  amber: '#B45309',
  warning: '#D97706',
  /** The amber tag's fill, and a key check's tick. */
  amberFill: 'rgba(245,158,11,0.16)',
  successFill: 'rgba(31,157,85,0.12)',
  errorFill: 'rgba(215,0,21,0.10)',
  connected: '#16A34A',
  /** A soft accent wash behind a small accent glyph (a send arrow, a mock row). */
  accentSoft: '#E6EDFC',
  /** The brand-blue screens (onboarding intro, sign in): the gradient's light top and deep foot. */
  brandLight: '#7DA2F2',
  brandTop: '#5B81E4',
  brandDeep: '#163992',
  /** The highlighted words of a title on the brand blue. */
  brandHighlight: '#B9CEFF',
  /** An amber call-out: its fill, outline and text. */
  amberBg: '#FFF4E3',
  amberLine: '#F2B661',
  amberInk: '#8A5300',
  /** The brand glass gradient's two stops. */
  glassTop: '#5588F0',
  glassBottom: '#3466E2',
  /** The tab bar: white in light (Josh, 18 Nov), one step above the page in dark (K2). */
  tabBar: '#FFFFFF',
  /** The raised gradient's middle, for a ring drawn to match a raised surface (Style's picked tab). */
  raisedFill: '#FFFFFF',
  /** A stronger red for a live state (a recording's dot, an error badge); light keeps its own. */
  errorVivid: '#E5372B',
  /** An error line under a practice or a download: a deeper red on the light page. */
  errorLine: '#B42318',
  /**
   * The sign-in screens' blue (auth/look) and the white glass on it. The blue screens look the same
   * in both schemes (dark design §3.7), so these keep their values in dark.
   */
  signInTop: '#5A8DF4',
  signInMid: '#2F62DE',
  signInFoot: '#1C3FAE',
  /** The white brand glass's foot: white → this, on the blue screens. */
  whiteGlassFoot: '#E7ECF6',
  /** A field's outline and its error line on the blue. */
  onBlueErrorLine: '#FF9B9B',
  onBlueErrorText: '#FFD3D3',
} as const;

export type ThemeTokens = { readonly [K in keyof typeof lightTheme]: string };

/**
 * Dark (decisions K1–K8, Josh, 24 Nov): near-black page with a cool tint, cards one step lighter,
 * a lighter link blue (K5), lifted dark toast (K6). The brand glass and the blue screens keep
 * their colours; status colours lighten one step.
 */
export const darkTheme = {
  canvas: '#0E0F13',
  surface: '#1A1B21',
  surface2: '#202128',
  tile: '#25262E',
  track: '#2C2D36',
  trackStrong: '#363841',
  dotIdle: '#4A4C57',
  disabled: '#5C5E69',
  ink: '#F2F2F5',
  secondary: '#A2A2AD',
  tertiary: '#7B7B86',
  accent: '#6E9BFF',
  hairline: 'rgba(255,255,255,0.07)',
  divider: 'rgba(255,255,255,0.09)',
  fieldHairline: 'rgba(255,255,255,0.12)',
  selFill: 'rgba(110,155,255,0.18)',
  toast: 'rgba(44,45,54,0.96)',
  toastSolid: '#2C2D36',
  onToast: '#FFFFFF',
  toastRim: 'rgba(255,255,255,0.10)',
  toastAction: '#8FB2FF',
  onGlass: '#FFFFFF',
  sentBubble: '#26324D',
  struck: 'rgba(162,162,173,0.45)',
  pickedRing: 'rgba(110,155,255,0.9)',
  error: '#FF6B61',
  success: '#34C77B',
  amber: '#F5B54A',
  warning: '#F5A524',
  amberFill: 'rgba(245,181,74,0.16)',
  successFill: 'rgba(52,199,123,0.16)',
  errorFill: 'rgba(255,107,97,0.16)',
  connected: '#34C77B',
  accentSoft: '#1F2A44',
  brandLight: lightTheme.brandLight,
  brandTop: lightTheme.brandTop,
  brandDeep: lightTheme.brandDeep,
  brandHighlight: lightTheme.brandHighlight,
  amberBg: '#2E2416',
  amberLine: 'rgba(245,181,74,0.45)',
  amberInk: '#F5C47A',
  glassTop: lightTheme.glassTop,
  glassBottom: lightTheme.glassBottom,
  tabBar: '#16171C',
  raisedFill: '#27282F',
  errorVivid: '#FF6B61',
  errorLine: '#FF6B61',
  signInTop: lightTheme.signInTop,
  signInMid: lightTheme.signInMid,
  signInFoot: lightTheme.signInFoot,
  whiteGlassFoot: lightTheme.whiteGlassFoot,
  onBlueErrorLine: lightTheme.onBlueErrorLine,
  onBlueErrorText: lightTheme.onBlueErrorText,
} as const satisfies ThemeTokens;

/** Files not on `useTheme()` yet read the light palette. */
export const theme = lightTheme;

/**
 * Flat: cards, list groups, rows, chips, fields, avatars. White, a hairline, an inner top
 * highlight and a soft lift (the desktop's glass edge).
 */
export const flat = {
  backgroundColor: theme.surface,
  borderWidth: 1,
  borderColor: theme.hairline,
  boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.7), 0px 2px 10px rgba(15,23,42,0.06)',
} satisfies ViewStyle;

/**
 * Raised: only secondary (white) buttons, round header buttons, task chips and the active tab.
 * A white-to-cool-grey gradient, a white rim and a short blue-grey lift. Its parent never sets
 * `overflow: hidden`, so the lift isn't cut.
 */
export const raised = {
  backgroundColor: theme.surface,
  experimental_backgroundImage: 'linear-gradient(180deg, #FFFFFF 0%, #F3F4F8 100%)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.9)',
  boxShadow:
    'inset 0px 1px 0px #FFFFFF, 0px 3px 8px -1px rgba(8,28,110,0.09), 0px 1px 2px rgba(8,28,110,0.05)',
} satisfies ViewStyle;

/** A raised surface under the finger: a shade darker, the lift kept. */
export const raisedPressed = {
  experimental_backgroundImage: 'linear-gradient(180deg, #F4F5F8 0%, #E9EBF0 100%)',
} satisfies ViewStyle;

/** A switch or slider knob. */
export const knob = {
  backgroundColor: theme.surface,
  experimental_backgroundImage: 'linear-gradient(180deg, #FFFFFF 0%, #ECEAF0 100%)',
  boxShadow: 'inset 0px 1px 0px #FFFFFF, 0px 2px 4px rgba(8,28,110,0.22)',
} satisfies ViewStyle;

/** Inset: a switch that's off, a tab track, a slider or progress track. */
export const inset = {
  backgroundColor: theme.track,
  boxShadow: 'inset 0px 1px 3px rgba(0,0,0,0.06)',
} satisfies ViewStyle;

/**
 * The desktop's primary gloss (`BRAND_GLASS_SURFACE` in `src/components/ui/button.tsx`): a
 * top-to-bottom blue gradient with a light inner rim and no outer shadow. Primary buttons, a
 * switch that's on, slider and progress fills, the selected chip.
 */
export const glass = {
  experimental_backgroundImage: `linear-gradient(180deg, ${theme.glassTop} 0%, ${theme.glassBottom} 100%)`,
  boxShadow:
    'inset 0px 1px 0px rgba(255,255,255,0.6), inset 0px 0px 0px 1px rgba(255,255,255,0.16), inset 0px -1px 1px rgba(0,0,0,0.12)',
} satisfies ViewStyle;

/** Pressed glass: a touch darker and smaller, as on desktop (brightness 95%, scale 0.985). */
export const glassPressed = {
  filter: [{ brightness: 0.95 }],
  transform: [{ scale: 0.985 }],
} satisfies ViewStyle;

export interface Recipes {
  flat: ViewStyle;
  raised: ViewStyle;
  raisedPressed: ViewStyle;
  knob: ViewStyle;
  inset: ViewStyle;
  glass: ViewStyle;
  glassPressed: ViewStyle;
}

const lightRecipes: Recipes = { flat, raised, raisedPressed, knob, inset, glass, glassPressed };

/** The dark surfaces (design §2): no glow, black lifts, the knob kept light (K4), glass unchanged. */
const darkRecipes: Recipes = {
  flat: {
    backgroundColor: darkTheme.surface,
    borderWidth: 1,
    borderColor: darkTheme.hairline,
    boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.04), 0px 2px 10px rgba(0,0,0,0.35)',
  },
  raised: {
    backgroundColor: darkTheme.surface,
    experimental_backgroundImage: 'linear-gradient(180deg, #2B2C34 0%, #23242B 100%)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    boxShadow:
      'inset 0px 1px 0px rgba(255,255,255,0.10), 0px 3px 8px -1px rgba(0,0,0,0.45), 0px 1px 2px rgba(0,0,0,0.35)',
  },
  raisedPressed: {
    experimental_backgroundImage: 'linear-gradient(180deg, #25262D 0%, #1E1F25 100%)',
  },
  knob: {
    backgroundColor: '#FFFFFF',
    experimental_backgroundImage: 'linear-gradient(180deg, #FFFFFF 0%, #D9DAE1 100%)',
    boxShadow: 'inset 0px 1px 0px #FFFFFF, 0px 2px 4px rgba(0,0,0,0.5)',
  },
  inset: {
    backgroundColor: darkTheme.track,
    boxShadow: 'inset 0px 1px 3px rgba(0,0,0,0.45)',
  },
  glass,
  glassPressed,
};

/** The surface recipes for a scheme. Each scheme's set is built once, so styles stay stable. */
export function recipes(scheme: Scheme): Recipes {
  return scheme === 'dark' ? darkRecipes : lightRecipes;
}

/** The palette for a scheme. */
export function tokens(scheme: Scheme): ThemeTokens {
  return scheme === 'dark' ? darkTheme : lightTheme;
}
