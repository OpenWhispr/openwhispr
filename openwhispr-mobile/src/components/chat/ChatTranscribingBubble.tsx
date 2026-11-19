import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/Text';
import { BRAND_GRADIENT, CHAT_COLORS } from '@/config/colors';
import { formatElapsed } from './formatElapsed';
import { usePulseStyle } from './useChatMotion';

interface ChatTranscribingBubbleProps {
  elapsedSeconds: number;
}

const BAR_WIDTHS = ['100%', '82%', '55%'] as const;

export function ChatTranscribingBubble({
  elapsedSeconds,
}: ChatTranscribingBubbleProps): React.JSX.Element {
  const pulse = usePulseStyle(0.35, 900);

  return (
    <View className="w-[78%] self-end">
      <View className="overflow-hidden" style={styles.bubble}>
        <LinearGradient
          colors={BRAND_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.bars}
        >
          {BAR_WIDTHS.map((width) => (
            <Animated.View key={width} style={[styles.bar, { width }, pulse]} />
          ))}
        </LinearGradient>
      </View>
      <Text className="mt-1.5 self-end text-[13px] text-secondaryLabel">
        {`Transcribing ${formatElapsed(elapsedSeconds)} of audio`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 6,
    borderBottomLeftRadius: 18,
    borderCurve: 'continuous',
  },
  bars: { padding: 14, gap: 8 },
  bar: { height: 9, borderRadius: 5, backgroundColor: CHAT_COLORS.onGradientSubtle },
});
