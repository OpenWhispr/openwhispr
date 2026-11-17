import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/Text';
import { BRAND_GRADIENT } from '@/config/colors';

interface ChatUserBubbleProps {
  text: string;
}

export function ChatUserBubble({ text }: ChatUserBubbleProps): React.JSX.Element {
  return (
    <View className="max-w-[84%] self-end overflow-hidden" style={styles.bubble}>
      <LinearGradient
        colors={BRAND_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.padding}
      >
        <Text className="text-[16px] leading-[22px] text-white" selectable>
          {text}
        </Text>
      </LinearGradient>
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
  padding: { paddingHorizontal: 14, paddingVertical: 10 },
});
