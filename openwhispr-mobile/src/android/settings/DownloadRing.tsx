import { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { home } from '../home/kit';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const SIZE = 28;
const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Lucide's check, so the drawn check matches the selected row's tick exactly.
const CHECK = 'M20 6 9 17l-5-5';
const CHECK_LENGTH = 22.63;

export type RingPhase = 'downloading' | 'setting-up' | 'done';

/**
 * V1 Ring: fills live while bytes arrive (with a stop square, which is also Cancel), spins
 * while the model is checked and unpacked, then closes and draws a check (240 ms).
 */
export function DownloadRing({
  phase,
  progress,
  reduceMotion,
}: {
  phase: RingPhase;
  progress: number;
  reduceMotion: boolean;
}) {
  const fill = useRef(new Animated.Value(progress)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(1)).current;
  const check = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: phase === 'downloading' ? progress : phase === 'setting-up' ? 0.25 : 1,
      // Live progress is linear: each sample glides to the next.
      duration: reduceMotion ? 0 : phase === 'done' ? 120 : 250,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [phase, progress, reduceMotion, fill]);

  useEffect(() => {
    if (phase !== 'setting-up' || reduceMotion) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, reduceMotion, spin]);

  useEffect(() => {
    if (phase !== 'done') {
      ring.setValue(1);
      check.setValue(0);
      return;
    }
    if (reduceMotion) {
      ring.setValue(0);
      check.setValue(1);
      return;
    }
    Animated.sequence([
      Animated.delay(120),
      Animated.parallel([
        // Native, like the spin on the same view: mixing drivers on one view throws.
        Animated.timing(ring, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(check, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]),
    ]).start();
  }, [phase, reduceMotion, ring, check]);

  return (
    <View style={{ width: SIZE, height: SIZE }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: SIZE,
          height: SIZE,
          opacity: ring,
          transform: [
            { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
          ],
        }}
      >
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={home.fill}
            strokeWidth={2.5}
            fill="none"
          />
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={home.accent}
            strokeWidth={2.5}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={fill.interpolate({
              inputRange: [0, 1],
              outputRange: [CIRCUMFERENCE, 0],
            })}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
          {phase === 'downloading' && (
            <Rect x={10} y={10} width={8} height={8} rx={1.5} fill={home.accent} />
          )}
        </Svg>
      </Animated.View>
      {phase === 'done' && (
        <Svg
          width={22}
          height={22}
          viewBox="0 0 24 24"
          style={{ position: 'absolute', top: 3, left: 3 }}
        >
          <AnimatedPath
            d={CHECK}
            stroke={home.accent}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={CHECK_LENGTH}
            strokeDashoffset={check.interpolate({
              inputRange: [0, 1],
              outputRange: [CHECK_LENGTH, 0],
            })}
          />
        </Svg>
      )}
    </View>
  );
}
