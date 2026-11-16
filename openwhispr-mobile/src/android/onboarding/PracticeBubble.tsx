import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
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

const HEIGHTS = [10, 18, 26, 16, 24, 12, 20];

// Bars follow the microphone level, so they stay flat until someone speaks.
function Waveform() {
  const level = useSharedValue(0);
  useEffect(() => {
    // The meter learns the room: the quietest recent level is the noise floor, and only sound
    // clearly above it moves the bars. The floor creeps up slowly so a noisy room settles too.
    // The first readings after the mic opens are artificially quiet, so they don't set the floor.
    let floor = 1;
    let samples = 0;
    const timer = setInterval(() => {
      let next = 0;
      try {
        next = AndroidDictation?.getRecordingLevel?.() ?? 0;
      } catch {
        next = 0;
      }
      samples += 1;
      if (samples > 4 && next > 0) floor = Math.min(next, floor + 0.004);
      const speech = Math.max(0, Math.min(1, (next - floor - 0.1) / 0.35));
      level.value = withTiming(speech, { duration: 90 });
    }, 80);
    return () => clearInterval(timer);
  }, [level]);
  return (
    <View style={b.wave} accessible={false}>
      {HEIGHTS.map((height, index) => (
        <Bar key={index} height={height} index={index} level={level} />
      ))}
    </View>
  );
}

function Bar({
  height,
  index,
  level,
}: {
  height: number;
  index: number;
  level: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const wobble = 0.75 + 0.25 * Math.sin(index * 1.7 + level.value * 9);
    return { height: 4 + (height - 4) * Math.min(1, level.value * 1.6) * wobble };
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
  wave: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 30 },
  bar: { width: 4, borderRadius: 2, backgroundColor: colors.accent },
});
