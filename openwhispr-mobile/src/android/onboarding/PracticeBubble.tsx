import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  Easing,
  ZoomIn,
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { BubbleIcon, GLASS_GRADIENT, PulseRings, colors } from './kit';
import { useOnboardingT } from './strings';

export type BubbleState = 'idle' | 'pulsing' | 'listening' | 'processing' | 'pasted';

/** How long a finger stays on the bubble before its menu opens (as the real bubble). */
export const HOLD_MS = 400;
const SIZE = 56;

/** The filled glyphs from the V3 board, in a 14-unit box. */
export const GLYPHS = {
  sparkle:
    'M7 0C7.525 4.025 9.975 6.475 14 7C9.975 7.525 7.525 9.975 7 14C6.475 9.975 4.025 7.525 0 7C4.025 6.475 6.475 4.025 7 0Z',
  globe:
    'M7 0C10.8661 0 14 3.1339 14 7C14 10.8661 10.8661 14 7 14C3.1339 14 0 10.8661 0 7C0 3.1339 3.1339 0 7 0ZM7 0.6125C8.7397 0.6125 10.15 3.4722 10.15 7C10.15 10.5278 8.7397 13.3875 7 13.3875C5.2603 13.3875 3.85 10.5278 3.85 7C3.85 3.4722 5.2603 0.6125 7 0.6125ZM7 0.9625C8.0632 0.9625 8.925 3.6655 8.925 7C8.925 10.3345 8.0632 13.0375 7 13.0375C5.9368 13.0375 5.075 10.3345 5.075 7C5.075 3.6655 5.9368 0.9625 7 0.9625ZM0.525 6.3875H13.475V7.6125H0.525V6.3875Z',
  pencil:
    'M9.2081 1.03356L12.9664 4.7919L4.3221 13.4362L0 14L0.56376 9.6779L9.2081 1.03356ZM10.2416 0L14 3.7584L13.3423 4.4161L9.5839 0.65772L10.2416 0Z',
} as const;
export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size, color }: { name: GlyphName; size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Path d={GLYPHS[name]} fill={color} fillRule="evenodd" />
    </Svg>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The practice bubble, drawn to match the real one (Variant 1): the app icon when idle; brand glass
 * with bars that follow the voice while listening, and a ✕ beside it; three dots while writing.
 * a ✓ once the words are in. Tapping the listening bubble stops and inserts. With [onHold], holding
 * fills a brand-blue ring (V3) and opens the menu after 400 ms, as on the real bubble; [onHoldStart]
 * and [onHoldCancel] let the screen say "Keep holding…" while the ring fills.
 */
export function PracticeBubble({
  state,
  badge,
  onPress,
  onStop,
  onCancel,
  onHold,
  onHoldStart,
  onHoldCancel,
}: {
  state: BubbleState;
  badge?: GlyphName;
  onPress: () => void;
  onStop: () => void;
  onCancel: () => void;
  onHold?: () => void;
  onHoldStart?: () => void;
  onHoldCancel?: () => void;
}) {
  const t = useOnboardingT();
  const reduced = useReducedMotion();
  const press = useSharedValue(1);
  const ring = useSharedValue(0);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  const circumference = Math.PI * (SIZE + 8);
  const trackProps = useAnimatedProps(() => ({ opacity: ring.value > 0 ? 1 : 0 }));
  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - ring.value),
    opacity: ring.value > 0 ? 1 : 0,
  }));

  if (state === 'pasted')
    return (
      <Animated.View
        entering={ZoomIn.duration(200)}
        style={b.disc}
        accessibilityLiveRegion="polite"
      >
        <LinearGradient
          colors={GLASS_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={b.glass}
        >
          <SystemIcon name="checkmark" mdName="Check" size={24} color="#FFFFFF" />
        </LinearGradient>
      </Animated.View>
    );

  if (state === 'listening' || state === 'processing')
    return (
      <View style={b.row}>
        {state === 'listening' ? (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('cancelLabel')}
            onPress={onCancel}
            hitSlop={8}
            style={b.cancel}
          >
            <SystemIcon name="xmark" mdName="X" size={14} color={colors.ink} />
          </Pressable>
        ) : null}
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={state === 'listening' ? t('stopLabel') : t('hintWriting')}
          accessibilityLiveRegion="polite"
          onPress={state === 'listening' ? onStop : undefined}
          style={b.disc}
        >
          {state === 'listening' ? <Halo /> : null}
          <LinearGradient
            colors={GLASS_GRADIENT}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={b.glass}
          >
            {state === 'listening' ? <Bars /> : <Dots still={reduced} />}
          </LinearGradient>
          {badge ? (
            <View style={b.badge}>
              <Glyph name={badge} size={10} color={colors.brandMid} />
            </View>
          ) : null}
        </Pressable>
      </View>
    );

  const begin = () => {
    press.value = withTiming(0.94, { duration: 80 });
    if (!onHold) return;
    held.current = false;
    ring.value = 0;
    ring.value = withTiming(1, { duration: HOLD_MS, easing: Easing.linear });
    onHoldStart?.();
    timer.current = setTimeout(() => {
      held.current = true;
      timer.current = null;
      ring.value = 0;
      onHold();
    }, HOLD_MS);
  };
  const end = () => {
    press.value = withSpring(1, { damping: 14, stiffness: 300 });
    // Let go before the ring closed: no menu.
    if (timer.current) onHoldCancel?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    ring.value = withTiming(0, { duration: 100 });
  };

  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={onHold ? t('bubbleHoldLabel') : t('bubbleLabel')}
      accessibilityActions={onHold ? [{ name: 'longpress' }] : undefined}
      onAccessibilityAction={(event) => {
        // TalkBack's double-tap-and-hold, so the menu step can be done without a timed hold.
        if (event.nativeEvent.actionName === 'longpress') onHold?.();
      }}
      onPressIn={begin}
      onPressOut={end}
      // A tap dictates on the lift; a hold that opened the menu doesn't.
      onPress={() => {
        if (!held.current) onPress();
      }}
      hitSlop={10}
      style={b.disc}
    >
      {state === 'pulsing' ? <PulseRings size={SIZE} /> : null}
      {onHold ? (
        <Svg width={SIZE + 12} height={SIZE + 12} style={b.ring} pointerEvents="none">
          <AnimatedCircle
            cx={(SIZE + 12) / 2}
            cy={(SIZE + 12) / 2}
            r={(SIZE + 8) / 2}
            stroke="rgba(21,75,212,0.18)"
            strokeWidth={3}
            fill="none"
            animatedProps={trackProps}
          />
          <AnimatedCircle
            cx={(SIZE + 12) / 2}
            cy={(SIZE + 12) / 2}
            r={(SIZE + 8) / 2}
            stroke={colors.brandMid}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={circumference}
            animatedProps={ringProps}
            transform={`rotate(-90 ${(SIZE + 12) / 2} ${(SIZE + 12) / 2})`}
          />
        </Svg>
      ) : null}
      <Animated.View style={pressStyle}>
        <BubbleIcon size={SIZE} />
      </Animated.View>
    </Pressable>
  );
}

// A port of the real bubble's bars (BubbleFace): five white bars, tallest in the middle, eased toward
// the microphone level every frame with a gentle wobble, never flat. Same -60…-20 dBFS level.
const BAR_SHAPE = [0.55, 0.85, 1, 0.85, 0.55];
const BAR_MAX = SIZE * 0.39;

function useLevel() {
  const target = useSharedValue(0);
  const level = useSharedValue(0);
  const phase = useSharedValue(0);
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        target.value = AndroidDictation?.getRecordingLevel?.() ?? 0;
      } catch {
        target.value = 0;
      }
    }, 50);
    return () => clearInterval(timer);
  }, [target]);
  useFrameCallback(() => {
    level.value += (target.value - level.value) * 0.3;
    phase.value += 0.18;
  });
  return { level, phase };
}

function Halo() {
  const { level } = useLevel();
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.3 * level.value }] }));
  return <Animated.View pointerEvents="none" style={[b.halo, style]} />;
}

function Bars() {
  const { level, phase } = useLevel();
  return (
    <View style={b.bars} accessible={false}>
      {BAR_SHAPE.map((shape, index) => (
        <Bar key={index} index={index} shape={shape} level={level} phase={phase} />
      ))}
    </View>
  );
}

function Bar({
  index,
  shape,
  level,
  phase,
}: {
  index: number;
  shape: number;
  level: SharedValue<number>;
  phase: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const wobble = 0.75 + 0.25 * Math.sin(phase.value + index * 1.3);
    const value = Math.min(1, Math.max(0, level.value));
    const height = Math.min(1, Math.max(0.18, 0.18 + 0.82 * value * shape * wobble));
    return { height: height * BAR_MAX };
  });
  return <Animated.View style={[b.bar, style]} />;
}

// Three white dots that ripple, 900 ms a cycle, 120 ms apart.
function Dots({ still }: { still: boolean }) {
  const clock = useSharedValue(0);
  useFrameCallback((frame) => {
    if (!still) clock.value = frame.timeSinceFirstFrame;
  });
  return (
    <View style={b.dots} accessible={false}>
      {[0, 1, 2].map((index) => (
        <Dot key={index} index={index} clock={clock} />
      ))}
    </View>
  );
}

function Dot({ index, clock }: { index: number; clock: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const t = (((clock.value - index * 120) % 900) + 900) % 900;
    const lift = Math.max(0, Math.sin((t / 900) * 2 * Math.PI));
    return { transform: [{ translateY: -lift * 3 }] };
  });
  return <Animated.View style={[b.dot, style]} />;
}

const b = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  disc: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  glass: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  halo: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: 'rgba(85,136,240,0.16)',
  },
  ring: { position: 'absolute' },
  cancel: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
  },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3, height: BAR_MAX },
  bar: { width: 3.4, borderRadius: 2, backgroundColor: '#FFFFFF' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFFFFF' },
});
