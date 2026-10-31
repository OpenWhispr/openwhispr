import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { BRAND_GRADIENT, CHAT_COLORS } from '@/config/colors';
import { usePulseStyle } from './useChatMotion';

export function ChatSparkle(): React.JSX.Element {
  const pulse = usePulseStyle(0.6, 1100);
  return (
    <Animated.View style={[styles.tile, pulse]}>
      <LinearGradient
        colors={BRAND_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.fill}
      >
        <SystemIcon name="sparkles" mdName="Sparkles" size={16} color={CHAT_COLORS.onGradient} />
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 30, height: 30, borderRadius: 9, borderCurve: 'continuous', overflow: 'hidden' },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
