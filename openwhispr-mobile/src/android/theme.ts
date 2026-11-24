import type { ViewStyle } from 'react-native';

/**
 * Android's one colour and surface source ("Glossy white" 3b, Figma page "🤖 Android · Glossy
 * white (exploration)", components board 5489:17090). Every other token object (`home`, `look`,
 * `notesLook`, onboarding `colors`, style `ink`, `palette`, `authColors`) points here; screens
 * never write a hex of their own, except third-party logos. Light mode only.
 */
export const theme = {
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
  /** A selected row or tile: the accent at 12%. */
  selFill: 'rgba(21,85,212,0.12)',
  /** The dark toast pill; `toastSolid` is the snackbar with an action. */
  toast: 'rgba(29,29,36,0.92)',
  toastSolid: '#1D1D24',
  /** Labels and icons on the brand glass. */
  onGlass: '#FFFFFF',
  /** Your own message bubble in an example (Style's previews). */
  sentBubble: '#E3EBFC',
  /** Words a tone drops, struck out in an example: the secondary grey at 45%. */
  struck: 'rgba(102,99,110,0.45)',
  /** The ring round a picked card (the tone setup's decks). */
  pickedRing: 'rgba(52,102,226,0.9)',
  /** The brand glass gradient's two stops. */
  glassTop: '#5588F0',
  glassBottom: '#3466E2',
} as const;

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
