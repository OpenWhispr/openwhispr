import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { useHomeT } from './strings';

/** The iOS design file's tokens (Figma "Android Home — reference"). */
export const home = {
  canvas: '#F8F6F5',
  surface: '#FFFFFF',
  accent: '#1555D4',
  text: '#181714',
  secondary: '#6E6D69',
  tertiary: '#A8A7A3',
  borderSubtle: '#E8E7E4',
  borderDefault: '#D9D8D4',
  divider: 'rgba(0,0,0,0.08)',
  fill: '#E8E7E4',
  tint: 'rgba(21,75,212,0.12)',
  warningBackground: '#FFF4E5',
  warning: '#DB7C00',
  error: '#E5372B',
  cardShadow: '0px 8px 12px rgba(0,0,0,0.06), 0px 1px 1px rgba(0,0,0,0.04)',
  tipShadow: '0px 8px 24px rgba(0,0,0,0.06), 0px 1px 2px rgba(0,0,0,0.04)',
  floatingShadow: '0px 12px 32px rgba(0,0,0,0.10), 0px 4px 12px rgba(0,0,0,0.08)',
} as const;

export const type = {
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '500' as const, color: home.text },
  subhead: { fontSize: 15, lineHeight: 20, color: home.text },
  footnote: { fontSize: 13, lineHeight: 18, color: home.secondary },
  section: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500' as const,
    color: home.tertiary,
    letterSpacing: 0.96,
    textTransform: 'uppercase' as const,
  },
};

export function SectionHeader({ title }: { title: string }) {
  return (
    <Text accessibilityRole="header" style={type.section}>
      {title}
    </Text>
  );
}

/** Small pill button. The icon sits in a 28 px slot and follows the label colour. */
export function PillButton({
  label,
  icon,
  onPress,
  primary,
  disabled,
  busy,
  style,
}: {
  label: string;
  icon?: LucideIconName;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = Boolean(disabled || busy);
  const color = primary ? '#FFFFFF' : inactive ? home.tertiary : home.text;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: 36,
          borderRadius: 999,
          paddingHorizontal: 14,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          backgroundColor: primary ? home.accent : home.surface,
          borderWidth: primary ? 0 : 1,
          borderColor: home.borderSubtle,
          // A disabled secondary button drops its shadow (Figma Button, tone = disabled).
          boxShadow: primary || inactive ? undefined : home.cardShadow,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {icon && !busy ? (
        <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
          <SystemIcon name="circle" mdName={icon} size={19} color={color} />
        </View>
      ) : null}
      <Text numberOfLines={1} style={[type.subhead, { color, flexShrink: 1 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The account button: the person's initials, never the OpenWhispr mark. */
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
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: home.accent,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {signedIn ? (
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#FFFFFF' }}>{initials}</Text>
        ) : (
          <SystemIcon name="person" mdName="UserRound" size={18} color="#FFFFFF" />
        )}
      </View>
    </Pressable>
  );
}

/** "Copied to clipboard" and friends: a pill that pops up at the bottom, above the tabs. */
export function HomeToast({ message, showId }: { message: string; showId: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(16)).current;
  useEffect(() => {
    if (!showId || !message) return;
    AccessibilityInfo.announceForAccessibility(message);
    opacity.setValue(0);
    lift.setValue(16);
    const show = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]);
    const hide = Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 8, duration: 180, useNativeDriver: true }),
    ]);
    show.start();
    const timer = setTimeout(() => hide.start(), 2200);
    return () => {
      clearTimeout(timer);
      show.stop();
    };
  }, [showId, message, opacity, lift]);
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{
        position: 'absolute',
        bottom: 12,
        alignSelf: 'center',
        maxWidth: 361,
        opacity,
        transform: [{ translateY: lift }],
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 999,
        backgroundColor: home.surface,
        boxShadow: home.floatingShadow,
      }}
    >
      <SystemIcon name="checkmark" mdName="Check" size={20} color={home.accent} />
      <Text style={{ fontSize: 17, lineHeight: 24, fontWeight: '500', color: home.text }}>
        {message}
      </Text>
    </Animated.View>
  );
}
