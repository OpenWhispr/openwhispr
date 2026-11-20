import { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { AppFont } from '@/lib/fonts';

// The onboarding sign-in look (Figma "Android · Onboarding" v3-01b/c/d): blue glass background,
// white glass pills without a drop shadow, see-through fields. One look for onboarding and the app.
export const authColors = {
  top: '#5A8DF4',
  mid: '#2F62DE',
  bottom: '#1C3FAE',
  ink: '#181714',
  brandInk: '#0F4ACC',
  icon: '#1555D4',
  glass: 'rgba(255,255,255,0.12)',
  circle: 'rgba(255,255,255,0.72)',
  line: 'rgba(255,255,255,0.75)',
  faint: 'rgba(255,255,255,0.72)',
  link: 'rgba(255,255,255,0.85)',
  errorStroke: '#FF9B9B',
  errorText: '#FFD3D3',
};

const FRAME_WIDTH = 393;

/** The blue background: three-stop gradient, two faint diagonal streaks and two soft glows. */
export function AuthBackground({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const k = width / FRAME_WIDTH;
  return (
    <View style={{ flex: 1, backgroundColor: authColors.mid }}>
      <LinearGradient
        colors={[authColors.top, authColors.mid, authColors.bottom]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id="streakA" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.08} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </SvgGradient>
          <SvgGradient id="streakB" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.05} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </SvgGradient>
          <RadialGradient id="glowDark" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0.45" stopColor="#0E2A8C" stopOpacity={0.55} />
            <Stop offset="1" stopColor="#0E2A8C" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="glowLight" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0.45" stopColor="#9CC3FF" stopOpacity={0.5} />
            <Stop offset="1" stopColor="#9CC3FF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={10 * k} cy={(770 / 852) * height} r={300 * k} fill="url(#glowDark)" />
        <Circle cx={330 * k} cy={100 * k} r={270 * k} fill="url(#glowLight)" />
        <Rect
          x={(361 - 45) * k}
          y={351 * k - 600 * k}
          width={90 * k}
          height={1200 * k}
          fill="url(#streakA)"
          transform={`rotate(28 ${361 * k} ${351 * k})`}
        />
        <Rect
          x={(471 - 45) * k}
          y={351 * k - 600 * k}
          width={90 * k}
          height={1200 * k}
          fill="url(#streakB)"
          transform={`rotate(28 ${471 * k} ${351 * k})`}
        />
      </Svg>
      {children}
    </View>
  );
}

/** The logo row, with Back (onboarding, a step inside the flow) or Close (in the app) at the right. */
export function AuthHeader({
  action,
  label,
  onPress,
  disabled,
}: {
  action?: 'back' | 'close';
  label: string;
  onPress?: () => void;
  /** Shown faded and locked, as while a reset link is sending (3.3). */
  disabled?: boolean;
}) {
  return (
    <View style={s.header}>
      <View style={s.logo} accessibilityRole="image" accessibilityLabel="OpenWhispr">
        <OpenWhisprMark size={28} color="#FFFFFF" />
        <Text style={s.logoWord}>OpenWhispr</Text>
      </View>
      {action && onPress ? (
        <Pressable
          cssInterop={false}
          onPress={onPress}
          disabled={disabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: Boolean(disabled) }}
          style={({ pressed }) => [s.circle, disabled && s.faded, pressed && s.pressed]}
        >
          <SystemIcon
            name={action === 'back' ? 'chevron.left' : 'xmark'}
            mdName={action === 'back' ? 'ChevronLeft' : 'X'}
            size={action === 'back' ? 22 : 20}
            color={authColors.icon}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

export function AuthTitle({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" style={s.title}>
      {children}
    </Text>
  );
}

/** Body line under the title; <b>…</b> spans are drawn white and medium (an email, mostly). */
export function AuthLine({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const parts = text.split(/<b>(.*?)<\/b>/g);
  return (
    <Text style={[s.line, style]}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <Text key={index} style={s.strong}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Text shown in place of the label while the action runs ("Signing in…"). */
  busyLabel?: string;
  busy?: boolean;
  /** Faded with the rest of the form while another action runs. */
  faded?: boolean;
  icon?: ReactNode;
  accessibilityLabel?: string;
};

/**
 * White brand glass: #FFFFFF → #E7ECF6, a white top highlight and rim, a faint navy bottom edge.
 * No drop shadow (Josh, 19 Nov).
 */
export function WhiteButton({
  label,
  onPress,
  disabled,
  busy,
  busyLabel,
  faded,
  icon,
  accessibilityLabel,
}: ButtonProps) {
  const locked = disabled || busy || faded;
  return (
    <Pressable
      cssInterop={false}
      onPress={onPress}
      disabled={locked}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(locked), busy: Boolean(busy) }}
      style={({ pressed }) => [
        s.pill,
        (disabled || faded) && s.faded,
        pressed && { transform: [{ scale: 0.98 }] },
      ]}
    >
      <LinearGradient colors={['#FFFFFF', '#E7ECF6']} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={s.whiteRim} />
      <View pointerEvents="none" style={s.whiteBottom} />
      {icon ? <View style={s.icon}>{icon}</View> : null}
      {busy && !busyLabel ? (
        <ActivityIndicator color={authColors.brandInk} />
      ) : (
        <Text
          numberOfLines={1}
          style={[s.pillLabel, { color: icon ? authColors.ink : authColors.brandInk }]}
        >
          {busy && busyLabel ? busyLabel : label}
        </Text>
      )}
    </Pressable>
  );
}

/** See-through glass pill: Continue before an email is typed, Resend while it counts down. */
export function ClearButton({ label, onPress, disabled, faded, accessibilityLabel }: ButtonProps) {
  return (
    <Pressable
      cssInterop={false}
      onPress={onPress}
      disabled={disabled || faded}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled || faded) }}
      style={({ pressed }) => [s.pill, s.clear, faded && s.faded, pressed && s.pressed]}
    >
      <Text numberOfLines={1} style={[s.pillLabel, { color: '#FFFFFF' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Plain white words that act: Forgot password?, Use another account, Back to sign in. */
export function TextButton({
  label,
  onPress,
  faded,
  strong,
}: {
  label: string;
  onPress: () => void;
  faded?: boolean;
  /** Full white, as "Continue without an account" is drawn. */
  strong?: boolean;
}) {
  return (
    <Pressable
      cssInterop={false}
      onPress={onPress}
      disabled={faded}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(faded) }}
      style={({ pressed }) => [s.textButton, faded && s.faded, pressed && s.pressed]}
    >
      <Text style={[s.textLabel, strong && { color: '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

export const AuthField = forwardRef<
  TextInput,
  TextInputProps & {
    error?: boolean;
    faded?: boolean;
    /** Show / Hide for a password field. */
    reveal?: {
      shown: boolean;
      onToggle: () => void;
      showLabel: string;
      hideLabel: string;
      show: string;
      hide: string;
    };
  }
>(function AuthField({ error, faded, reveal, style, value, onFocus, onBlur, ...props }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={[
        s.field,
        focused && !error && s.fieldFocused,
        error && s.fieldError,
        faded && s.faded,
      ]}
    >
      <TextInput
        {...props}
        ref={ref}
        value={value}
        editable={!faded}
        placeholderTextColor={authColors.faint}
        selectionColor="#FFFFFF"
        cursorColor="#FFFFFF"
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        // Typed text sits centred, as drawn; the placeholder keeps the start.
        style={[s.input, value ? { textAlign: 'center' } : null, style]}
      />
      {reveal ? (
        <Pressable
          cssInterop={false}
          onPress={reveal.onToggle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={reveal.shown ? reveal.hideLabel : reveal.showLabel}
          style={({ pressed }) => [s.reveal, pressed && s.pressed]}
        >
          <Text style={s.revealLabel}>{reveal.shown ? reveal.hide : reveal.show}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

export function FieldNote({
  text,
  error,
  quiet,
}: {
  text: string;
  error?: boolean;
  /** A hint rather than a rule: regular weight, the body line's white. */
  quiet?: boolean;
}) {
  return (
    <Text
      accessibilityLiveRegion={error ? 'polite' : 'none'}
      style={[
        s.note,
        quiet && { fontFamily: AppFont.regular, color: authColors.line },
        error && { color: authColors.errorText },
      ]}
    >
      {text}
    </Text>
  );
}

export function OrDivider({ label }: { label: string }) {
  return (
    <View
      style={s.divider}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={s.dividerLine} />
      <Text style={s.dividerLabel}>{label}</Text>
      <View style={s.dividerLine} />
    </View>
  );
}

export function Legal({ text }: { text: string }) {
  return <Text style={s.legal}>{text}</Text>;
}

export function GoogleLogo() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <Path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <Path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <Path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </Svg>
  );
}

export function MicrosoftLogo() {
  return (
    <Svg width={22} height={22} viewBox="0 0 23 23">
      <Path d="M0 0h11v11H0z" fill="#F25022" />
      <Path d="M12 0h11v11H12z" fill="#7FBA00" />
      <Path d="M0 12h11v11H0z" fill="#00A4EF" />
      <Path d="M12 12h11v11H12z" fill="#FFB900" />
    </Svg>
  );
}

export const authLayout: { content: ViewStyle; stack: ViewStyle; group: ViewStyle } = {
  content: { flexGrow: 1, paddingHorizontal: 16, paddingBottom: 24, gap: 20 },
  stack: { gap: 12 },
  group: { gap: 8 },
};

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    marginTop: 16,
  },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logoWord: { fontFamily: AppFont.bold, fontSize: 20, lineHeight: 26, color: '#FFFFFF' },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: authColors.circle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: AppFont.bold,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.32,
    color: '#FFFFFF',
  },
  line: { fontFamily: AppFont.regular, fontSize: 17, lineHeight: 22, color: authColors.line },
  strong: { fontFamily: AppFont.medium, color: '#FFFFFF' },
  pill: {
    height: 50,
    borderRadius: 25,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  whiteRim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 25,
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
  clear: {
    backgroundColor: authColors.glass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    borderTopColor: 'rgba(255,255,255,0.35)',
  },
  icon: {
    position: 'absolute',
    left: 20,
    top: 0,
    bottom: 0,
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLabel: { fontFamily: AppFont.medium, fontSize: 17, lineHeight: 22 },
  textButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  textLabel: { fontFamily: AppFont.medium, fontSize: 17, lineHeight: 22, color: authColors.link },
  field: {
    height: 48,
    borderRadius: 12,
    backgroundColor: authColors.glass,
    borderWidth: 1.5,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
  },
  fieldFocused: { borderColor: 'rgba(255,255,255,0.55)' },
  fieldError: { borderColor: authColors.errorStroke },
  input: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 14,
    fontFamily: AppFont.regular,
    fontSize: 17,
    color: '#FFFFFF',
  },
  reveal: { paddingHorizontal: 14, height: '100%', justifyContent: 'center' },
  revealLabel: { fontFamily: AppFont.medium, fontSize: 15, color: authColors.link },
  note: { fontFamily: AppFont.medium, fontSize: 13, lineHeight: 18, color: '#FFFFFF' },
  divider: { flexDirection: 'row', alignItems: 'center', height: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: authColors.glass },
  dividerLabel: {
    paddingHorizontal: 20,
    fontFamily: AppFont.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.96,
    textTransform: 'uppercase',
    color: authColors.faint,
  },
  legal: {
    fontFamily: AppFont.regular,
    fontSize: 13,
    lineHeight: 18,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  faded: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
