import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';

interface KeyboardDetectedToastProps {
  message: string;
}

/**
 * Floating confirmation that the OpenWhispr keyboard was seen. Rendered only once
 * detection fires, so mounting is the moment worth announcing: the callers dismiss
 * themselves shortly after, and a VoiceOver user would otherwise get a haptic and
 * then find themselves somewhere else with no explanation.
 */
export function KeyboardDetectedToast({ message }: KeyboardDetectedToastProps) {
  const insets = useSafeAreaInsets();

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
  }, [message]);

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(180)}
      pointerEvents="none"
      style={[styles.container, { top: insets.top + 24 }]}
    >
      <View
        accessibilityLiveRegion="polite"
        className="flex-row items-center justify-center gap-2 rounded-xl border border-separator bg-secondarySystemGroupedBackground px-4 py-3"
        style={styles.shadow}
      >
        <SystemIcon
          name="checkmark.circle.fill"
          mdName="CheckCircle2"
          size={18}
          color="systemGreen"
        />
        <Text className="text-[15px] font-semibold text-label">{message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 24, right: 24 },
  // Subtle elevation so the toast lifts off the page.
  shadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
});
