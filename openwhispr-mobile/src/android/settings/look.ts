import type { TextStyle, ViewStyle } from 'react-native';
import { homeLook, useHome } from '../home/kit';
import { themeFor, type AndroidTheme } from '../ThemeProvider';
import type { Scheme } from '../theme';

/**
 * Settings in OpenWhispr's glossy white design language (`../theme`): flat cards and fields,
 * raised buttons, grey icon tiles, square badges. One per scheme (`useSettingsLook()`), so a
 * light/dark switch repaints a page in place. Processing's `processingFable/look.tsx` builds on it.
 */
function buildSettingsLook(theme: AndroidTheme) {
  const k = theme.tokens;
  const h = homeLook(theme);
  const edge: ViewStyle = theme.flat;
  return {
    theme,
    look: {
      canvas: k.canvas,
      selFill: k.selFill,
      idleFill: k.tile,
      track: k.track,
      error: k.error,
      hairline: k.hairline,
      fieldHairline: k.fieldHairline,
      edgeShadow: theme.flat.boxShadow as string,
    },
    /** The glass edge: a hairline, an inner top highlight and a soft lift, on the surface. */
    edge,
    /** A flat card with the glass edge. */
    edgeCard: { ...edge, borderRadius: 16, overflow: 'hidden' } satisfies ViewStyle,
    /** A text field: corners 12 and a slightly darker hairline. */
    edgeField: { ...edge, borderRadius: 12, borderColor: k.fieldHairline } satisfies ViewStyle,
    sectionLabel: h.type.section as TextStyle,
    /** Body copy on the canvas (an intro above a card). */
    bodyText: { fontSize: 16, lineHeight: 21, color: k.ink } satisfies TextStyle,
  };
}

export type SettingsLook = ReturnType<typeof buildSettingsLook>;

const looks: Partial<Record<Scheme, SettingsLook>> = {};

/** Settings' look for a theme, built once per scheme so styles and memo inputs stay stable. */
export function settingsLookFor(theme: AndroidTheme): SettingsLook {
  return (looks[theme.scheme] ??= buildSettingsLook(theme));
}

/** Settings' look for the scheme in use. Read it at render; a switch re-renders in place. */
export function useSettingsLook(): SettingsLook {
  return settingsLookFor(useHome().theme);
}

// Light only, for files the dark theme hasn't moved yet (onboarding, account flows; see
// `__tests__/themeAtRenderPending.ts`). Remove each once nothing imports it.
const lightLook = settingsLookFor(themeFor('light'));
/** @deprecated Light only: read `useSettingsLook().look`. */
export const look = lightLook.look;
/** @deprecated Light only: read `useSettingsLook().edge`. */
export const edge: ViewStyle = lightLook.edge;
/** @deprecated Light only: read `useSettingsLook().edgeCard`. */
export const edgeCard: ViewStyle = lightLook.edgeCard;
/** @deprecated Light only: read `useSettingsLook().edgeField`. */
export const edgeField: ViewStyle = lightLook.edgeField;
/** @deprecated Light only: read `useSettingsLook().sectionLabel`. */
export const sectionLabel: TextStyle = lightLook.sectionLabel;
/** @deprecated Light only: read `useSettingsLook().bodyText`. */
export const bodyText: TextStyle = lightLook.bodyText;
