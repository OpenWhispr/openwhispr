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
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingT } from './strings';

export const colors = {
  canvas: '#F1F0EE',
  surface: '#FFFFFF',
  surface2: '#F7F6F4',
  fill: '#E9E8E4',
  ink: '#1A1A1A',
  secondary: '#55534F',
  tertiary: '#8C8A85',
  divider: '#E2E0DB',
  accent: '#1E55D6',
  accentSoft: '#E6EDFC',
  brandTop: '#5B81E4',
  brandMid: '#154BD4',
  brandDeep: '#163992',
  green: '#22A350',
  amberBg: '#FFF4E3',
  amberLine: '#F2B661',
  amberInk: '#8A5300',
};

export const GLASS_GRADIENT = ['#5588F0', '#3466E2'] as const;

// Words wrapped in [brackets] are drawn in the accent colour.
export function AccentText({
  text,
  style,
  accent = colors.accent,
  center,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  accent?: string;
  center?: boolean;
}) {
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
          <Text key={index} style={{ color: accent }}>
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
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={s.glassLabel} numberOfLines={1}>
            {label}
          </Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

// White brand glass for the brand-blue screens: the approved sign-in recipe (#FFFFFF → #E7ECF6,
// a white top highlight and rim, a faint navy bottom edge). No drop shadow.
export function WhiteButton({ label, onPress, disabled, busy, style }: ButtonProps) {
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
      <LinearGradient colors={['#FFFFFF', '#E7ECF6']} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={s.whiteRim} />
      <View pointerEvents="none" style={s.whiteBottom} />
      {busy ? (
        <ActivityIndicator color={colors.brandMid} />
      ) : (
        <Text style={[s.glassLabel, { color: colors.brandMid }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.secondary, pressed && { opacity: 0.7 }, style]}
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
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.link, pressed && { opacity: 0.6 }]}
    >
      <Text style={[s.linkLabel, light && { color: '#FFFFFF' }]}>{label}</Text>
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
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.circle, pressed && { opacity: 0.7 }]}
    >
      <SystemIcon
        name={icon === 'back' ? 'chevron.left' : 'xmark'}
        mdName={icon === 'back' ? 'ChevronLeft' : 'X'}
        size={icon === 'back' ? 22 : 18}
        color={icon === 'back' ? colors.accent : colors.ink}
      />
    </Pressable>
  );
}

export function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.pill, pressed && { opacity: 0.7 }]}
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
  return <View style={[s.card, style]}>{children}</View>;
}

const BUBBLE = require('./assets/bubble.png');

// The bubble, drawn from the desktop's Liquid Glass dock icon.
export function BubbleIcon({ size = 56 }: { size?: number }) {
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
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, s.center]}>
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

export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.canvas },
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
    color: colors.ink,
    letterSpacing: -0.6,
  },
  body: { fontSize: 17, lineHeight: 24, color: colors.secondary },
  caption: { fontSize: 14, lineHeight: 20, color: colors.tertiary },
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
  glassLabel: { color: '#FFFFFF', fontSize: 17, fontFamily: AppFont.medium },
  whiteRim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    borderTopColor: '#FFFFFF',
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
    minHeight: 54,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    marginTop: 8,
  },
  secondaryLabel: { color: colors.ink, fontSize: 17, fontFamily: AppFont.medium },
  link: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  linkLabel: { color: colors.accent, fontSize: 17, fontFamily: AppFont.medium },
  circle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLabel: { color: colors.ink, fontSize: 16, fontFamily: AppFont.medium },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 16,
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  bubble: {
    shadowColor: '#163992',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
});
