import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { KeyboardDetectedToast } from '@/components/onboarding/KeyboardDetectedToast';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SpaceGrotesk } from '@/lib/fonts';
import { useKeyboardHeartbeat } from '@/hooks/useKeyboardHeartbeat';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';

const STEP_ID = 'keyboard-switch';

// Worklet-safe color literals — `interpolateColor` runs on the UI thread, so
// PlatformColor / iosColor() can't be used here. These match `systemBlue` and
// the light-mode `label` token; in dark mode the highlight still resolves to
// brand blue + white text (the unselected row color comes from the un-animated
// child <Text> below via Tailwind).
const HIGHLIGHT_BG = '#007AFF';
const HIGHLIGHT_TEXT = '#FFFFFF';
const UNHIGHLIGHTED_TEXT = '#000000';
const TRANSPARENT = 'rgba(0,0,0,0)';

const ROW_HEIGHT = 48;

export function KeyboardSwitchStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const inputRef = useRef<TextInput>(null);
  const detected = useKeyboardHeartbeat(goNext);

  useEffect(() => {
    // Bring up the system keyboard so the user can reach the globe key.
    // A short delay lets the screen finish presenting before iOS animates the
    // keyboard up.
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(focusTimer);
  }, []);

  const handleManualAdvance = useCallback(() => {
    goNext();
  }, [goNext]);

  const titleNode = <KeyboardSwitchTitle />;

  return (
    <>
      <OnboardingShell
        progress={getStepProgress(STEP_ID)}
        title="Almost done. Press and hold the globe icon in the bottom-left corner of your keyboard, then select OpenWhispr."
        titleNode={titleNode}
        ctaLabel="I switched"
        onCta={handleManualAdvance}
      >
        <View className="flex-1 items-center justify-start pt-6">
          <AnimatedKeyboardSwitchPreview />
        </View>

        {/* Invisible focusable target — pulls up the system keyboard so the
            user can long-press the globe key. We don't care about typed text. */}
        <TextInput
          ref={inputRef}
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          caretHidden
          style={{ position: 'absolute', height: 1, width: 1, opacity: 0 }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </OnboardingShell>

      {detected ? <KeyboardDetectedToast message="OpenWhispr keyboard is active" /> : null}
    </>
  );
}

function KeyboardSwitchTitle() {
  return (
    <View>
      <Text className="text-[28px] font-medium leading-[34px] text-label">Almost done.</Text>
      <View className="flex-row flex-wrap items-center">
        <Text className="text-[28px] font-medium leading-[34px] text-label">
          Press and hold the{' '}
        </Text>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-secondarySystemGroupedBackground">
          <SystemIcon name="globe" mdName="Globe" size={16} color="label" />
        </View>
        <Text className="text-[28px] font-medium leading-[34px] text-label">
          {' '}
          icon in the bottom-left corner of your keyboard, then select{' '}
          <Text className="text-primary">OpenWhispr</Text>
        </Text>
      </View>
    </View>
  );
}

function AnimatedKeyboardSwitchPreview() {
  // 0 → hand sits on the "English (US)" row, OpenWhispr row is neutral.
  // 1 → hand has moved down to "OpenWhispr", which becomes brand-highlighted.
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 0 }),
        withDelay(700, withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) })),
        withDelay(1200, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );
  }, [progress]);

  return (
    <View
      style={{ width: 260 }}
      className="overflow-hidden rounded-2xl bg-secondarySystemGroupedBackground"
    >
      <PopoverRow label="Keyboard Settings…" muted />
      <Divider />
      <PopoverRow label="English (US)" />
      <Divider />
      <HighlightedRow label="OpenWhispr" progress={progress} />
      <Hand progress={progress} />
    </View>
  );
}

function PopoverRow({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <View style={{ height: ROW_HEIGHT }} className="flex-row items-center justify-center px-4">
      <Text className={`text-[16px] ${muted ? 'text-secondaryLabel' : 'text-label'}`}>{label}</Text>
    </View>
  );
}

function HighlightedRow({ label, progress }: { label: string; progress: SharedValue<number> }) {
  const bgStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [TRANSPARENT, HIGHLIGHT_BG]),
  }));
  const textStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [UNHIGHLIGHTED_TEXT, HIGHLIGHT_TEXT]),
  }));

  return (
    <Animated.View
      style={[{ height: ROW_HEIGHT }, bgStyle]}
      className="flex-row items-center justify-center px-4"
    >
      <Animated.Text style={[styles.highlightedRowLabel, textStyle]}>{label}</Animated.Text>
    </Animated.View>
  );
}

function Hand({ progress }: { progress: SharedValue<number> }) {
  // Float between the English row (top of the hand) and the OpenWhispr row.
  // English row top = ROW_HEIGHT * 1 + 1 divider, OpenWhispr row top = ROW_HEIGHT * 2 + 2 dividers.
  const handStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: ROW_HEIGHT * (1 + progress.value) + progress.value * 2 }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          right: 30,
          top: 8,
        },
        handStyle,
      ]}
    >
      <Text style={{ fontSize: 30 }}>👆</Text>
    </Animated.View>
  );
}

function Divider() {
  return <View className="ml-4 h-px bg-separator" />;
}

const styles = StyleSheet.create({
  highlightedRowLabel: {
    fontFamily: SpaceGrotesk.semibold,
    fontSize: 16,
    fontWeight: '600',
  },
});
