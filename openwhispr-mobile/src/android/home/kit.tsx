import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { useHomeT } from './strings';
import { flat, glass, glassPressed, raised, raisedPressed, theme } from '../theme';

/**
 * The flat surface: a hairline, an inner top highlight and a soft lift, on white. Settings'
 * `edge` (../settings/look) is this value. The tokens live in `../theme`.
 */
export const glassEdge = flat;

/** Home's tokens, from the one theme (`../theme`). */
export const home = {
  canvas: theme.canvas,
  surface: theme.surface,
  accent: theme.accent,
  text: theme.ink,
  secondary: theme.secondary,
  tertiary: theme.tertiary,
  borderSubtle: theme.track,
  borderDefault: theme.trackStrong,
  divider: theme.divider,
  fill: theme.track,
  tint: theme.selFill,
  error: '#E5372B',
  disabled: theme.disabled,
  cardShadow: '0px 8px 12px rgba(0,0,0,0.06), 0px 1px 1px rgba(0,0,0,0.04)',
  tipShadow: '0px 8px 24px rgba(0,0,0,0.06), 0px 1px 2px rgba(0,0,0,0.04)',
  floatingShadow: '0px 12px 32px rgba(0,0,0,0.10), 0px 4px 12px rgba(0,0,0,0.08)',
} as const;

/** The brand glass every primary button uses (`../theme` `glass`). */
export const gloss = glass;

/** Pressed glass: a touch darker and smaller. */
export const glossPressed = glassPressed;

export const type = {
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '500' as const, color: home.text },
  subhead: { fontSize: 15, lineHeight: 20, color: home.text },
  footnote: { fontSize: 13, lineHeight: 18, color: home.secondary },
  // Section labels: uppercase Medium 11 at 6% tracking (Settings' `sectionLabel`).
  section: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '500' as const,
    color: home.tertiary,
    letterSpacing: 0.66,
    textTransform: 'uppercase' as const,
  },
};

/** An uppercase section label; an optional text action (Tips' Hide) sits on its right. */
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 16 }}>
      <Text accessibilityRole="header" style={[type.section, { flex: 1 }]}>
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
            color: home.accent,
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

/** The grey of an icon tile (Settings' idle fill). */
export const TILE_FILL = theme.tile;

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
  const color = primary ? '#FFFFFF' : home.text;
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
        primary ? gloss : raised,
        !primary && pressed && !disabled && raisedPressed,
        primary && pressed && !disabled && glossPressed,
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
          type.subhead,
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
  color = home.text,
  children,
}: {
  icon?: LucideIconName;
  color?: string;
  children?: React.ReactNode;
}) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: TILE_FILL,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {children ??
        (icon ? <SystemIcon name="circle" mdName={icon} size={18} color={color} /> : null)}
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
        backgroundColor: pressed ? home.borderSubtle : TILE_FILL,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <SystemIcon name="circle" mdName={icon} size={18} color={accent ? home.accent : home.text} />
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
          signedIn ? gloss : glassEdge,
        ]}
      >
        {signedIn ? (
          <Text
            style={{
              fontSize: 13,
              lineHeight: 18,
              fontWeight: '500',
              color: '#FFFFFF',
              textAlign: 'center',
            }}
          >
            {initials}
          </Text>
        ) : (
          <SystemIcon name="person" mdName="UserRound" size={18} color={home.text} />
        )}
      </View>
    </Pressable>
  );
}
