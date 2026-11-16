import { useCallback } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useHardwareKeyboardConnected } from '@/hooks/useHardwareKeyboardConnected';
import { useConfigStore } from '@/store/useConfigStore';
import { safeHaptics } from '@/lib/utils';

/**
 * One-time Home card shown the first time a hardware keyboard is attached,
 * pointing at the hardware-keyboard dictation shortcut. Opening the guide or
 * dismissing both count as seen.
 */
export function HardwareKeyboardNudgeBanner() {
  const connected = useHardwareKeyboardConnected();
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const markSeen = useCallback(() => {
    updateConfig({ hardwareKeyboardNudgeDismissedAt: new Date().toISOString() });
  }, [updateConfig]);

  const open = useCallback(() => {
    safeHaptics('selection');
    markSeen();
    router.push('/(account)/hardware-keyboard');
  }, [markSeen]);

  const dismiss = useCallback(() => {
    safeHaptics('light');
    markSeen();
  }, [markSeen]);

  // No config yet means we can't know it was dismissed; wait rather than flash.
  if (Platform.OS !== 'ios' || !connected || !config || config.hardwareKeyboardNudgeDismissedAt) {
    return null;
  }

  return (
    <View
      className="mt-3 flex-row items-center gap-2 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-3"
      style={{ borderCurve: 'continuous' }}
      testID="hardware-keyboard-nudge"
    >
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel="Using a keyboard? Dictate into any app with a shortcut"
        accessibilityHint="Shows how to set up the hardware keyboard shortcut"
        testID="hardware-keyboard-nudge-cta"
        className="min-w-0 flex-1 flex-row items-center gap-3"
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-tertiarySystemFill">
          <SystemIcon name="command" mdName="Command" size={20} color="brand" />
        </View>
        <Text className="min-w-0 flex-1 text-[15px] font-medium text-label">
          Using a keyboard? Dictate into any app with a shortcut
        </Text>
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={14} color="tertiaryLabel" />
      </Pressable>
      <Pressable
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss hardware keyboard tip"
        testID="hardware-keyboard-nudge-dismiss"
        className="h-8 w-8 items-center justify-center rounded-full"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SystemIcon name="xmark" mdName="X" size={14} color="secondaryLabel" />
      </Pressable>
    </View>
  );
}
