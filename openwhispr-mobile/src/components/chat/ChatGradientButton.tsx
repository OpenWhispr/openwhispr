import { Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT, CHAT_COLORS } from '@/config/colors';

export const COMPOSER_BUTTON_SIZE = 40;
export const COMPOSER_BUTTON_RADIUS = 13;
const RING_WIDTH = 3;

interface ChatGradientButtonProps {
  label: string;
  disabled: boolean;
  onPress: () => void;
  /** Rings the button while it's live, e.g. the mic while it listens. */
  active?: boolean;
  children: React.ReactNode;
}

export function ChatGradientButton({
  label,
  disabled,
  onPress,
  active = false,
  children,
}: ChatGradientButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={2}
      style={disabled ? styles.disabled : undefined}
    >
      {/* Drawn outside the button, so the ring doesn't move it. */}
      {active ? <View pointerEvents="none" style={styles.ring} /> : null}
      <LinearGradient
        colors={BRAND_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.fill}
      >
        {children}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.4 },
  fill: {
    width: COMPOSER_BUTTON_SIZE,
    height: COMPOSER_BUTTON_SIZE,
    borderRadius: COMPOSER_BUTTON_RADIUS,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    top: -RING_WIDTH,
    right: -RING_WIDTH,
    bottom: -RING_WIDTH,
    left: -RING_WIDTH,
    borderRadius: COMPOSER_BUTTON_RADIUS + RING_WIDTH,
    borderCurve: 'continuous',
    borderWidth: RING_WIDTH,
    borderColor: CHAT_COLORS.listeningRing,
  },
});
