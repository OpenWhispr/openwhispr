import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import {
  dismissFullAccessBanner,
  evaluate,
  shouldShowFullAccessBanner,
} from '@/lib/keyboardFullAccessProbe';
import { safeHaptics } from '@/lib/utils';

/**
 * Home banner asking — not asserting — whether keyboard dictation broke. The
 * signal (installed keyboard, no heartbeat stamped by this build) cannot
 * distinguish "revoked" from "hasn't typed since updating", so the copy is a
 * question; a user whose keyboard is fine reads it and ignores it. Visibility
 * lives in lib/keyboardFullAccessProbe; this component owns the dismissal
 * write and navigation. Off iOS the probe reads nothing and the rule is false.
 */
export function KeyboardFullAccessBanner() {
  const [visible, setVisible] = useState(() => shouldShowFullAccessBanner(evaluate(Date.now())));

  // Re-evaluated on foreground so the banner clears itself once the keyboard
  // proves it can write again (or appears after a revoke elsewhere).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') setVisible(shouldShowFullAccessBanner(evaluate(Date.now())));
    });
    return () => subscription.remove();
  }, []);

  const open = useCallback(() => {
    safeHaptics('selection');
    router.push('/keyboard-full-access');
  }, []);

  const dismiss = useCallback(() => {
    safeHaptics('light');
    dismissFullAccessBanner(Date.now());
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <View
      className="mt-3 flex-row items-center gap-2 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-3"
      style={{ borderCurve: 'continuous' }}
      testID="keyboard-full-access-banner"
    >
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel="Keyboard dictation not working?"
        accessibilityHint="Shows how to turn Full Access back on"
        testID="keyboard-full-access-banner-cta"
        className="min-w-0 flex-1 flex-row items-center gap-3"
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-tertiarySystemFill">
          <SystemIcon name="keyboard" mdName="Keyboard" size={20} color="brand" />
        </View>
        <Text className="min-w-0 flex-1 text-[15px] font-medium text-label">
          Keyboard dictation not working?
        </Text>
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={14} color="tertiaryLabel" />
      </Pressable>
      <Pressable
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss keyboard dictation banner"
        testID="keyboard-full-access-banner-dismiss"
        className="h-8 w-8 items-center justify-center rounded-full"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SystemIcon name="xmark" mdName="X" size={14} color="secondaryLabel" />
      </Pressable>
    </View>
  );
}
