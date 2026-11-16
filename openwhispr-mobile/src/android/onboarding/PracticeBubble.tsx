import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { BubbleIcon, PulseRings, colors } from './kit';
import { useOnboardingT } from './strings';

export type BubbleState = 'idle' | 'pulsing' | 'listening' | 'processing';

// Drawn to match the approved bubble states: idle disc, listening pill, "Writing it up…" pill.
export function PracticeBubble({
  state,
  onPress,
  onStop,
  onCancel,
}: {
  state: BubbleState;
  onPress: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const t = useOnboardingT();
  if (state === 'listening')
    return (
      <View style={b.pill}>
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('cancelLabel')}
          onPress={onCancel}
          hitSlop={6}
          style={b.cancel}
        >
          <SystemIcon name="xmark" mdName="X" size={16} color={colors.ink} />
        </Pressable>
        <Waveform />
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('stopLabel')}
          onPress={onStop}
          hitSlop={6}
          style={b.stop}
        >
          <View style={b.stopSquare} />
        </Pressable>
      </View>
    );
  if (state === 'processing')
    return (
      <View style={[b.pill, { paddingHorizontal: 18, gap: 10 }]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={colors.accent} />
        <Text style={{ fontSize: 17, color: colors.ink, fontFamily: AppFont.medium }}>
          {t('hintWriting')}
        </Text>
      </View>
    );
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={t('bubbleLabel')}
      onPress={onPress}
      hitSlop={10}
      style={b.disc}
    >
      {state === 'pulsing' ? <PulseRings size={56} /> : null}
      <BubbleIcon size={56} />
    </Pressable>
  );
}

// A port of the real bubble's waveform (BubblePolicy.bars and WaveformView in the bubble
// module): seven bars, tallest in the middle, eased toward the microphone level every frame with
// a gentle wobble, and never fully flat. The level is the same -60…-20 dBFS scale.
const BAR_SHAPE = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];
const HEIGHT = 24;

function Waveform() {
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
    level.value += (target.value - level.value) * 0.35;
    phase.value += 0.18;
  });
  return (
    <View style={b.wave} accessible={false}>
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
    const height = Math.min(1, Math.max(0.15, 0.15 + 0.85 * value * shape * wobble));
    return { height: height * HEIGHT };
  });
  return <Animated.View style={[b.bar, style]} />;
}

const b = StyleSheet.create({
  disc: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  pill: {
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  cancel: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stop: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.brandMid,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#FFFFFF' },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 48 / 13, height: HEIGHT, width: 48 },
  bar: { width: 48 / 13, borderRadius: 2, backgroundColor: colors.accent },
});
