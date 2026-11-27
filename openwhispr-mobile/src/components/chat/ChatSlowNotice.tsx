import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/Text';
import { BRAND_GRADIENT, CHAT_COLORS } from '@/config/colors';
import { useLoopValue } from './useChatMotion';

const TRACK_HEIGHT = 3;
const BAR_SHARE = 0.4;

function SweepingProgress(): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const sweep = useLoopValue(1400, false);
  // The track spans the card, so the sweep is sized from its measured width.
  const [trackWidth, setTrackWidth] = useState(0);
  const barWidth = trackWidth * BAR_SHARE;
  // Reduced motion leaves a static partial fill at the start of the track
  // rather than parking the bar off to the left.
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: reducedMotion ? 0 : -barWidth + sweep.value * (trackWidth + barWidth) },
    ],
  }));
  return (
    <View
      className="overflow-hidden rounded-full"
      style={styles.track}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
    >
      <Animated.View style={[styles.bar, { width: barWidth }, style]}>
        <LinearGradient
          colors={BRAND_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fill}
        />
      </Animated.View>
    </View>
  );
}

/** The progress sweep and note under the "Still working" header. */
export function ChatSlowNotice(): React.JSX.Element {
  return (
    <View className="mt-2 gap-2">
      <SweepingProgress />
      <Text className="text-[13px] leading-[18px] text-secondaryLabel">
        Questions that span many notes can take up to a minute.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: TRACK_HEIGHT, backgroundColor: CHAT_COLORS.neutralTrack },
  bar: { height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, overflow: 'hidden' },
  fill: { flex: 1 },
});
