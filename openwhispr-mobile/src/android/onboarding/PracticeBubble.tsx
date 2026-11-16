import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
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
        <Text style={{ fontSize: 17, color: colors.ink, fontWeight: '500' }}>
          {t('hintWriting')}
        </Text>
      </View>
    );
  return (
    <Pressable
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

function Waveform() {
  return (
    <View style={b.wave} accessible={false}>
      {HEIGHTS.map((height, index) => (
        <Bar key={index} height={height} delay={index * 90} />
      ))}
    </View>
  );
}

function Bar({ height, delay }: { height: number; delay: number }) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(0.6);
  useEffect(() => {
    if (reduced) return;
    scale.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 260, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.4, { duration: 260, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
        true,
      ),
    );
  }, [delay, reduced, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: scale.value }] }));
  return <Animated.View style={[b.bar, { height }, style]} />;
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
