import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/android/store/useAuthStore';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { useHomeT } from './strings';
import { themeFor, useTheme, type AndroidTheme } from '../ThemeProvider';
import type { Scheme } from '../theme';

/** Home's colours, for one scheme (`useHome().c`). */
export interface HomeColors {
  canvas: string;
  surface: string;
  accent: string;
  text: string;
  secondary: string;
  tertiary: string;
  borderSubtle: string;
  borderDefault: string;
  divider: string;
  hairline: string;
  fill: string;
  tint: string;
  tile: string;
  error: string;
  /** A warning glyph (History couldn't load). */
  warning: string;
  disabled: string;
  onGlass: string;
  /** A new History row's highlight, from clear to its peak. */
  arrivalFrom: string;
  arrivalTo: string;
  /** The frame round a tip's light screenshot in dark (design §3.6); none in light. */
  posterFrame: string | undefined;
  cardShadow: string;
  tipShadow: string;
  floatingShadow: string;
}

const textStyles = (c: HomeColors) => ({
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '500' as const, color: c.text },
  subhead: { fontSize: 15, lineHeight: 20, color: c.text },
  /** A row's or a card's title. */
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '500' as const, color: c.text },
  footnote: { fontSize: 13, lineHeight: 18, color: c.secondary },
  // Section labels: uppercase Medium 11 at 6% tracking (Settings' `sectionLabel`).
  section: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '500' as const,
    color: c.tertiary,
    letterSpacing: 0.66,
    textTransform: 'uppercase' as const,
  },
});

/** Everything Home draws with, for the scheme in use. */
export interface HomeLook {
  c: HomeColors;
  type: ReturnType<typeof textStyles>;
  /** A flat card: the glass edge, corners 16. */
  card: ViewStyle;
  theme: AndroidTheme;
}

function buildHomeLook(theme: AndroidTheme): HomeLook {
  const k = theme.tokens;
  const dark = theme.scheme === 'dark';
  const c: HomeColors = {
    canvas: k.canvas,
    surface: k.surface,
    accent: k.accent,
    text: k.ink,
    secondary: k.secondary,
    tertiary: k.tertiary,
    borderSubtle: k.track,
    borderDefault: k.trackStrong,
    divider: k.divider,
    hairline: k.hairline,
    fill: k.track,
    tint: k.selFill,
    tile: k.tile,
    error: k.errorVivid,
    warning: dark ? k.amber : '#C27A00',
    disabled: k.disabled,
    onGlass: k.onGlass,
    arrivalFrom: dark ? 'rgba(110,155,255,0)' : 'rgba(21,85,212,0)',
    arrivalTo: dark ? 'rgba(110,155,255,0.16)' : 'rgba(21,85,212,0.10)',
    posterFrame: dark ? k.surface2 : undefined,
    cardShadow: dark
      ? '0px 8px 12px rgba(0,0,0,0.35), 0px 1px 1px rgba(0,0,0,0.25)'
      : '0px 8px 12px rgba(0,0,0,0.06), 0px 1px 1px rgba(0,0,0,0.04)',
    tipShadow: dark
      ? '0px 8px 24px rgba(0,0,0,0.35), 0px 1px 2px rgba(0,0,0,0.25)'
      : '0px 8px 24px rgba(0,0,0,0.06), 0px 1px 2px rgba(0,0,0,0.04)',
    floatingShadow: dark
      ? '0px 12px 32px rgba(0,0,0,0.50), 0px 4px 12px rgba(0,0,0,0.40)'
      : '0px 12px 32px rgba(0,0,0,0.10), 0px 4px 12px rgba(0,0,0,0.08)',
  };
  return {
    c,
    type: textStyles(c),
    card: { ...theme.flat, borderRadius: 16, overflow: 'hidden' },
    theme,
  };
}

const looks: Partial<Record<Scheme, HomeLook>> = {};

/** Home's look for a theme, built once per scheme so styles and memo inputs stay stable. */
export function homeLook(theme: AndroidTheme): HomeLook {
  return (looks[theme.scheme] ??= buildHomeLook(theme));
}

/** Home's look for the scheme in use; a light/dark switch re-renders in place. */
export function useHome(): HomeLook {
  return homeLook(useTheme());
}

// Light only. The theme-at-render guard keeps every Android file off these, so they can go once
// no test reads them either.
const lightLook = homeLook(themeFor('light'));
/** @deprecated Light only: read `useHome().c`. */
export const home = lightLook.c;
/** @deprecated Light only: read `useHome().type`. */
export const type = lightLook.type;
/** @deprecated Light only: read `useTheme().flat`. */
export const glassEdge = lightLook.theme.flat;
/** The brand glass every primary button uses; the same in both schemes. */
export const gloss = lightLook.theme.glass;
/** Pressed glass: a touch darker and smaller. */
export const glossPressed = lightLook.theme.glassPressed;

/** An uppercase section label; an optional text action (Tips' Hide) sits on its right. */
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  const { c, type: text } = useHome();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 16 }}>
      <Text accessibilityRole="header" style={[text.section, { flex: 1 }]}>
        {title}
      </Text>
      {action ? (
        <Text
          accessibilityRole="button"
          suppressHighlighting
          onPress={action.onPress}
          style={{
            fontSize: 13,
            lineHeight: 16,
            fontWeight: '500',
            color: c.accent,
            paddingVertical: 12,
            marginVertical: -12,
            paddingLeft: 16,
          }}
        >
          {action.label}
        </Text>
      ) : null}
    </View>
  );
}

/** Horizontal room a compact PillButton with an icon needs besides its label (padding, icon slot, gap, border); two share a row on a narrow phone. */
export const PILL_ICON_CHROME_COMPACT = 8 * 2 + 28 + 4 + 2;

/** @deprecated Light only: read `useHome().c.tile`. */
export const TILE_FILL = lightLook.c.tile;

/**
 * A button inside a card: a raised white pill, 44 tall, with an ink label. `primary` is the one
 * thing a card asks for (a missing permission): the brand gloss with a white label, no outline.
 * Busy or disabled, it dims (40%, or 50% for primary); the label never changes. The icon sits in
 * a 28 px slot and follows the label colour, so a pair of buttons always shows same-size icons.
 */
export function PillButton({
  label,
  icon,
  onPress,
  primary,
  disabled,
  compact,
  style,
}: {
  label: string;
  icon?: LucideIconName;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Tighter side padding and icon gap, so two fit side by side on a narrow phone. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c, type: text, theme } = useHome();
  const color = primary ? c.onGlass : c.text;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: 44,
          borderRadius: 999,
          paddingHorizontal: compact ? 8 : 14,
          paddingVertical: 8,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: compact ? 4 : 8,
          opacity: disabled ? (primary ? 0.5 : 0.4) : 1,
        },
        // Primary keeps an explicit zero border: a gradient view whose border goes from unset to
        // 1 as it re-renders crashed Android's gradient drawing (LinearGradient
        // IllegalArgumentException).
        primary ? [theme.glass, { borderWidth: 0 }] : theme.raised,
        !primary && pressed && !disabled && theme.raisedPressed,
        primary && pressed && !disabled && theme.glassPressed,
        style,
      ]}
    >
      {icon ? (
        <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
          <SystemIcon name="circle" mdName={icon} size={19} color={color} />
        </View>
      ) : null}
      <Text
        style={[
          text.subhead,
          { color, flexShrink: 1, textAlign: 'center', fontWeight: primary ? '600' : '500' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** An icon in a 36 grey tile, corners 10 (Settings' list rows). */
export function IconTile({
  icon,
  color,
  children,
}: {
  icon?: LucideIconName;
  /** The glyph's colour; ink by default. */
  color?: string;
  children?: React.ReactNode;
}) {
  const { c } = useHome();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: c.tile,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {children ??
        (icon ? (
          <SystemIcon name="circle" mdName={icon} size={18} color={color ?? c.text} />
        ) : null)}
    </View>
  );
}

/** A 36 grey tile that is a button: History's Copy and Retry (Retry in blue). */
export function TileButton({
  icon,
  label,
  onPress,
  disabled,
  accent,
}: {
  icon: LucideIconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  const { c } = useHome();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: pressed ? c.borderSubtle : c.tile,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <SystemIcon name="circle" mdName={icon} size={18} color={accent ? c.accent : c.text} />
    </Pressable>
  );
}

/**
 * The account button: the person's initials on a 36 brand-glass circle, never the OpenWhispr
 * mark. Signed out it is a white circle with the glass edge and a person.
 */
export function AccountAvatar() {
  const t = useHomeT();
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const signedIn = Boolean(user && !user.isAnonymous);
  const { initials } = getAccountDisplay(user, isGuest);
  const { c, theme } = useHome();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={t('account')}
      onPress={() => router.push('/(account)')}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={[
          {
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
          },
          signedIn ? theme.glass : theme.flat,
        ]}
      >
        {signedIn ? (
          <Text
            style={{
              fontSize: 13,
              lineHeight: 18,
              fontWeight: '500',
              color: c.onGlass,
              textAlign: 'center',
            }}
          >
            {initials}
          </Text>
        ) : (
          <SystemIcon name="person" mdName="UserRound" size={18} color={c.text} />
        )}
      </View>
    </Pressable>
  );
}
