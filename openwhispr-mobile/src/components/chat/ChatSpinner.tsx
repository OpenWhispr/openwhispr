import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { BRAND, CHAT_COLORS } from '@/config/colors';
import { useLoopValue } from './useChatMotion';

// A static ring under reduced motion: useLoopValue holds at 0, so it never turns.
export function ChatSpinner(): React.JSX.Element {
  const turn = useLoopValue(900, false);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return <Animated.View style={[styles.ring, style]} />;
}

const styles = StyleSheet.create({
  ring: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: CHAT_COLORS.neutralRing,
    borderTopColor: BRAND,
  },
});
