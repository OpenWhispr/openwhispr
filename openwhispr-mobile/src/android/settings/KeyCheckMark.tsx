import { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { home } from '../home/kit';
import { theme } from '../theme';
import { useReduceMotion } from './kit';
import type { KeyCheckState } from './keyCheck';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

// Desktop's connection-status-icon.css, on a 24 unit grid drawn at 20 px.
const SIZE = 20;
const RING = 2 * Math.PI * 9;
const TICK = 15;
const STROKE_X = 9.9;
const BANG = 5.2;
const STANDARD = Easing.bezier(0.4, 0, 0.2, 1);
const TICK_EASE = Easing.bezier(0.65, 0, 0.35, 1);

export const KEY_CHECK_COLORS = {
  checking: home.secondary,
  connected: theme.connected,
  failed: home.error,
  unverified: theme.warning,
} as const;

const timing = (
  value: Animated.Value,
  toValue: number,
  duration: number,
  delay = 0,
  easing: (value: number) => number = Easing.ease,
  useNativeDriver = false,
) => Animated.timing(value, { toValue, duration, delay, easing, useNativeDriver });

/**
 * A stroke stays invisible until its dash starts drawing in: with round line ends, a fully
 * hidden dash still shows a dot where it begins.
 */
const shownWhileDrawing = (offset: Animated.Value, length: number) =>
  offset.interpolate({
    inputRange: [0, length * 0.97, length],
    outputRange: [1, 1, 0],
    extrapolate: 'clamp',
  });

/**
 * The status mark at the end of a key field: a grey arc spins while the key is checked, closes
 * green and gives way to a tick (accepted), closes red around an X (refused), or closes amber
 * around a "!" (no answer). Under reduced motion the final shape appears at once.
 */
export function KeyCheckMark({
  state,
  animate = true,
}: {
  state: Exclude<KeyCheckState, 'idle'>;
  /** False for a key that was already saved: it shows settled, with no haptic. */
  animate?: boolean;
}) {
  const reduceMotion = useReduceMotion();
  const instant = reduceMotion || !animate;
  // Native-driven: the spin, and the ring's shrink and fade. JS-driven: the stroke drawing.
  const spin = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(1)).current;
  const arc = useRef(new Animated.Value(RING * 0.74)).current;
  const tick = useRef(new Animated.Value(TICK)).current;
  const crossA = useRef(new Animated.Value(STROKE_X)).current;
  const crossB = useRef(new Animated.Value(STROKE_X)).current;
  const bang = useRef(new Animated.Value(BANG)).current;
  const dot = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (state !== 'checking' || reduceMotion) return;
    spin.setValue(0);
    const loop = Animated.loop(timing(spin, 1, 750, 0, Easing.linear, true));
    loop.start();
    return () => loop.stop();
  }, [state, reduceMotion, spin]);

  useEffect(() => {
    const done = state !== 'checking';
    if (instant || !done) {
      const settled = (shape: KeyCheckState) => instant && state === shape;
      ringScale.setValue(settled('connected') ? 0.55 : 1);
      ringOpacity.setValue(settled('connected') ? 0 : 1);
      arc.setValue(done ? 0 : RING * 0.74);
      tick.setValue(settled('connected') ? 0 : TICK);
      crossA.setValue(settled('failed') ? 0 : STROKE_X);
      crossB.setValue(settled('failed') ? 0 : STROKE_X);
      bang.setValue(settled('unverified') ? 0 : BANG);
      dot.setValue(settled('unverified') ? 1 : 0);
      // Reduced motion keeps the haptic; a key that was already saved gets none.
      const haptic =
        animate && state === 'connected'
          ? Haptics.AndroidHaptics.Confirm
          : animate && state === 'failed'
            ? Haptics.AndroidHaptics.Reject
            : null;
      if (instant && haptic) void Haptics.performAndroidHapticsAsync(haptic).catch(() => {});
      return;
    }
    const close = timing(arc, 0, 240, 0, STANDARD);
    let sequence: Animated.CompositeAnimation;
    let haptic: Haptics.AndroidHaptics | null = null;
    if (state === 'connected') {
      haptic = Haptics.AndroidHaptics.Confirm;
      sequence = Animated.parallel([
        close,
        Animated.parallel([
          timing(ringScale, 0.55, 300, 220, STANDARD, true),
          timing(ringOpacity, 0, 220, 260, Easing.ease, true),
        ]),
        timing(tick, 0, 320, 300, TICK_EASE),
      ]);
    } else if (state === 'failed') {
      haptic = Haptics.AndroidHaptics.Reject;
      sequence = Animated.parallel([
        close,
        timing(crossA, 0, 100, 240),
        timing(crossB, 0, 100, 340),
      ]);
    } else {
      sequence = Animated.parallel([close, timing(bang, 0, 200, 240), timing(dot, 1, 150, 400)]);
    }
    sequence.start(({ finished }) => {
      if (finished && haptic) void Haptics.performAndroidHapticsAsync(haptic).catch(() => {});
    });
    return () => sequence.stop();
  }, [state, instant, animate, ringScale, ringOpacity, arc, tick, crossA, crossB, bang, dot]);

  const color = KEY_CHECK_COLORS[state];
  const line = { stroke: color, strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' } as const;
  return (
    <View style={{ width: SIZE, height: SIZE }} accessible={false} importantForAccessibility="no">
      {/* A settled tick has no ring; a value set on a native-driven view before it is drawn can
          leave a trace of it. */}
      {!(instant && state === 'connected') && (
        <Animated.View
          style={{
            position: 'absolute',
            width: SIZE,
            height: SIZE,
            opacity: ringOpacity,
            transform: [
              { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
              { scale: ringScale },
            ],
          }}
        >
          <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24">
            <AnimatedCircle
              cx={12}
              cy={12}
              r={9}
              stroke={color}
              strokeWidth={2.2}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={[RING, RING]}
              strokeDashoffset={arc}
              // The arc starts at the top, as on desktop.
              rotation={-90}
              origin="12, 12"
            />
          </Svg>
        </Animated.View>
      )}
      <Svg width={SIZE} height={SIZE} viewBox="0 0 24 24" style={{ position: 'absolute' }}>
        {/* Only the current state's shape is drawn: a round line end still shows as a dot
            even when its stroke is hidden by the dash offset. */}
        {state === 'connected' && (
          <AnimatedPath
            d="M6.8 12.6l3.4 3.4 7-7.4"
            {...line}
            strokeLinejoin="round"
            strokeDasharray={[TICK, TICK]}
            strokeDashoffset={tick}
            strokeOpacity={shownWhileDrawing(tick, TICK)}
          />
        )}
        {state === 'failed' && (
          <>
            <AnimatedPath
              d="M8.5 8.5l7 7"
              {...line}
              strokeDasharray={[STROKE_X, STROKE_X]}
              strokeDashoffset={crossA}
              strokeOpacity={shownWhileDrawing(crossA, STROKE_X)}
            />
            <AnimatedPath
              d="M15.5 8.5l-7 7"
              {...line}
              strokeDasharray={[STROKE_X, STROKE_X]}
              strokeDashoffset={crossB}
              strokeOpacity={shownWhileDrawing(crossB, STROKE_X)}
            />
          </>
        )}
        {state === 'unverified' && (
          <>
            <AnimatedPath
              d="M12 7.6v5.2"
              {...line}
              strokeDasharray={[BANG, BANG]}
              strokeDashoffset={bang}
              strokeOpacity={shownWhileDrawing(bang, BANG)}
            />
            <AnimatedCircle cx={12} cy={16.3} r={1.25} fill={color} opacity={dot} />
          </>
        )}
      </Svg>
    </View>
  );
}
