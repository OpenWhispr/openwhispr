import { useEffect, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/android/shared/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingT } from './strings';
import { makeStyles, themeFor, useTheme, type AndroidTheme } from '../ThemeProvider';
import type { Scheme } from '../theme';

// The brand-blue screens (splash, pitch, the practice's blue card) look the same in both schemes.
const brand = themeFor('light').tokens;

function onboardingColors(theme: AndroidTheme) {
  const k = theme.tokens;
  return {
    canvas: k.canvas,
    surface: k.surface,
    surface2: k.surface2,
    fill: k.track,
    ink: k.ink,
    secondary: k.secondary,
    tertiary: k.tertiary,
    divider: k.trackStrong,
    accent: k.accent,
    accentSoft: k.accentSoft,
    brandTop: k.brandTop,
    /** The brand-blue screens' middle stop: the one accent blue (D3), the same in both schemes. */
    brandMid: brand.accent,
    brandDeep: k.brandDeep,
    green: k.success,
    amberBg: k.amberBg,
    amberLine: k.amberLine,
    amberInk: k.amberInk,
    onGlass: k.onGlass,
    /** An error line under a practice or a download (light keeps its deeper red). */
    error: k.errorLine,
  };
}

export type OnboardingColors = ReturnType<typeof onboardingColors>;

const palettes: Partial<Record<Scheme, OnboardingColors>> = {};

/** Onboarding's palette for a theme, built once per scheme. */
export function onboardingColorsFor(theme: AndroidTheme): OnboardingColors {
  return (palettes[theme.scheme] ??= onboardingColors(theme));
}

/** Onboarding's palette for the scheme in use. Read it at render; a switch repaints in place. */
export function useOnboardingColors(): OnboardingColors {
  return onboardingColorsFor(useTheme());
}

// The brand glass is the same blue in both schemes (design §1).
export const GLASS_GRADIENT = [brand.glassTop, brand.glassBottom] as const;

// Words wrapped in [brackets] are drawn in the accent colour.
export function AccentText({
  text,
  style,
  accent,
  center,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  accent?: string;
  center?: boolean;
}) {
  const s = useOnboardingStyles();
  const c = useOnboardingColors();
  const parts = keepLastWordsTogether(text)
    .split(/(\[[^\]]+\])/g)
    .filter(Boolean);
  return (
    <Text
      accessibilityRole="header"
      textBreakStrategy="balanced"
      style={[s.title, center && { textAlign: 'center' }, style]}
    >
      {parts.map((part, index) =>
        part.startsWith('[') ? (
          <Text key={index} style={{ color: accent ?? c.accent }}>
            {part.slice(1, -1)}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

// No word left alone on the last line: the last two words share a no-break space.
export function keepLastWordsTogether(text: string): string {
  return text.replace(/ (?=\S+$)/, '\u00A0');
}

export function plain(text: string): string {
  return text.replace(/[[\]]/g, '');
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
};

// The desktop's brand glass: a vertical blue gradient with a bright top rim. Flat: no drop shadow,
// on any CTA (Josh, 19 Nov). Disabled is the same glass at 50 %.
export function GlassButton({ label, onPress, disabled, busy, style }: ButtonProps) {
  const s = useOnboardingStyles();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      <LinearGradient colors={GLASS_GRADIENT} style={s.glass}>
        <View pointerEvents="none" style={s.glassRim} />
        {busy ? (
          <ActivityIndicator color={brand.onGlass} />
        ) : (
          <Text style={s.glassLabel} numberOfLines={1}>
            {label}
          </Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

// White brand glass for the brand-blue screens: the approved sign-in recipe (white → `whiteGlassFoot`,
// a white top highlight and rim, a faint navy bottom edge). No drop shadow. Ink label, never blue.
export function WhiteButton({ label, onPress, disabled, busy, style }: ButtonProps) {
  const s = useOnboardingStyles();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.glass,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      <LinearGradient
        colors={[brand.surface, brand.whiteGlassFoot]}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={s.whiteRim} />
      <View pointerEvents="none" style={s.whiteBottom} />
      {busy ? (
        <ActivityIndicator color={brand.ink} />
      ) : (
        <Text style={[s.glassLabel, { color: brand.ink }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled, style }: ButtonProps) {
  const s = useOnboardingStyles();
  const { raisedPressed } = useTheme();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.secondary, pressed && raisedPressed, style]}
    >
      <Text style={s.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

export function LinkButton({
  label,
  onPress,
  light,
}: {
  label: string;
  onPress: () => void;
  light?: boolean;
}) {
  const s = useOnboardingStyles();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.link, pressed && { opacity: 0.6 }]}
    >
      <Text style={[s.linkLabel, light && { color: brand.onGlass }]}>{label}</Text>
    </Pressable>
  );
}

export function CircleButton({
  icon,
  label,
  onPress,
}: {
  icon: 'back' | 'close';
  label: string;
  onPress: () => void;
}) {
  const s = useOnboardingStyles();
  const c = useOnboardingColors();
  const { raisedPressed } = useTheme();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.circle, pressed && raisedPressed]}
    >
      <SystemIcon
        name={icon === 'back' ? 'chevron.left' : 'xmark'}
        mdName={icon === 'back' ? 'ChevronLeft' : 'X'}
        size={icon === 'back' ? 22 : 18}
        color={c.ink}
      />
    </Pressable>
  );
}

export function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  const s = useOnboardingStyles();
  const { raisedPressed } = useTheme();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.pill, pressed && raisedPressed]}
    >
      <Text style={s.pillLabel}>{label}</Text>
    </Pressable>
  );
}

// A plain onboarding page: header (back, optional right action), scrolling body, pinned footer.
export function Screen({
  onBack,
  right,
  children,
  footer,
  scroll = true,
  contentStyle,
}: {
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useOnboardingT();
  const s = useOnboardingStyles();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[s.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[s.content, { flex: 1 }, contentStyle]}>{children}</View>
  );
  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom', 'left', 'right']}>
      <View style={s.header}>
        {onBack ? <CircleButton icon="back" label={t('back')} onPress={onBack} /> : <View />}
        {right ?? <View />}
      </View>
      {body}
      {footer ? <View style={s.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useOnboardingStyles();
  return <View style={[s.card, style]}>{children}</View>;
}

const BUBBLE = require('./assets/bubble.png');

// The bubble, drawn from the desktop's Liquid Glass dock icon.
export function BubbleIcon({ size = 56 }: { size?: number }) {
  const s = useOnboardingStyles();
  return (
    <View style={[s.bubble, { width: size, height: size, borderRadius: size / 2 }]}>
      <Image source={BUBBLE} style={{ width: size, height: size }} accessible={false} />
    </View>
  );
}

// A still halo, for screens where the bubble isn't asking to be tapped.
export function Halo({ size, color = 'rgba(52,102,226,0.14)' }: { size: number; color?: string }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

// Soft rings that breathe out from the bubble. Reduced motion keeps them still.
export function PulseRings({
  size,
  color = 'rgba(52,102,226,0.18)',
}: {
  size: number;
  color?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
    >
      {[0, 1].map((index) => (
        <Ring key={index} size={size} color={color} delay={index * 700} still={reduced} />
      ))}
    </View>
  );
}

function Ring({
  size,
  color,
  delay,
  still,
}: {
  size: number;
  color: string;
  delay: number;
  still: boolean;
}) {
  const progress = useSharedValue(still ? 0.5 : 0);
  useEffect(() => {
    if (still) return;
    progress.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }), -1, false),
    );
  }, [delay, progress, still]);
  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 + progress.value * 0.7 }],
  }));
  return (
    <Animated.View
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2 },
        { backgroundColor: color },
        style,
      ]}
    />
  );
}

/** Onboarding's shared styles for the scheme in use: `const s = useOnboardingStyles()`. */
export const useOnboardingStyles = makeStyles((t) => {
  const c = onboardingColorsFor(t);
  return {
    page: { flex: 1, backgroundColor: c.canvas },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 8,
      minHeight: 52,
    },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24, gap: 16 },
    footer: { paddingHorizontal: 16, paddingBottom: 12, paddingTop: 8, gap: 4 },
    title: {
      fontSize: 32,
      lineHeight: 38,
      fontFamily: AppFont.bold,
      color: c.ink,
      letterSpacing: -0.6,
    },
    body: { fontSize: 17, lineHeight: 24, color: c.secondary },
    caption: { fontSize: 14, lineHeight: 20, color: c.tertiary },
    center: { alignItems: 'center', justifyContent: 'center' },
    glass: {
      minHeight: 54,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      overflow: 'hidden',
    },
    glassRim: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
      borderTopColor: 'rgba(255,255,255,0.6)',
    },
    glassLabel: { color: t.tokens.onGlass, fontSize: 17, fontFamily: AppFont.medium },
    whiteRim: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.7)',
      borderTopColor: brand.surface,
    },
    whiteBottom: {
      position: 'absolute',
      left: 18,
      right: 18,
      bottom: 0,
      height: 1,
      backgroundColor: 'rgba(20,51,140,0.14)',
    },
    secondary: {
      ...t.raised,
      minHeight: 54,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
    },
    secondaryLabel: { color: c.ink, fontSize: 17, fontFamily: AppFont.medium },
    link: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    linkLabel: { color: c.accent, fontSize: 17, fontFamily: AppFont.medium },
    circle: {
      ...t.raised,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pill: {
      ...t.raised,
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillLabel: { color: c.ink, fontSize: 16, fontFamily: AppFont.medium },
    card: { ...t.flat, borderRadius: 16, padding: 16 },
    bubble: {
      shadowColor: brand.brandDeep,
      shadowOpacity: 0.35,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
  };
});
