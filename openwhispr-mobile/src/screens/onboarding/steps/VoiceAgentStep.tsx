import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Keyboard, PlatformColor, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingPracticeMode } from '@/hooks/useOnboardingPracticeMode';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { BRAND } from '@/config/colors';
import { SpaceGrotesk } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { useAuthStore } from '@/store/useAuthStore';
import { addKeyboardStatusChangedListener } from '../../../../modules/app-group-storage/src';

type Phase = 'start' | 'asking' | 'first-draft' | 'refined' | 'done';

// What users say in the live try, and what the example shows when the live try can't run.
const REQUEST =
  'I cancelled my subscription last month but got charged again. Draft an email asking them to refund it.';
const EXAMPLE_DRAFT =
  'Hi,\n\nI cancelled my subscription last month, but I was charged again this month. Could you please refund this charge?\n\nThanks';

// The field is focused on arrival, so the first instruction points straight at the keyboard's agent
// button, drawn with the same glyph the keyboard uses.
const INSTRUCTIONS: Record<Phase, ReactNode> = {
  start: (
    <>
      Tap the <SystemIcon name="wand.and.stars" mdName="WandSparkles" size={17} color="label" />{' '}
      button on your keyboard.
    </>
  ),
  asking: `Say: “${REQUEST}”`,
  'first-draft': 'Now tap Ask for changes and say: “Make it firmer.”',
  refined: 'Tap ✓ to insert it.',
  done: 'That’s your voice assistant.',
};

// Errors a retry can't clear: the server wants an account (the free tries are used up, the guest
// word quota is spent, or the server has no live try yet; only an account clears it) or the weekly
// word limit is reached (only its reset clears it).
const FINAL_ERROR_NOTES: Record<string, string> = {
  account_required: 'The live try isn’t available. Sign in at the end to use the voice assistant.',
  usage_limit:
    'You’ve reached the weekly word limit. Try the voice assistant again once it resets.',
};

export function VoiceAgentStep(): ReactElement {
  const { goNext, goBack, progress } = useOnboardingStep('voice-agent');
  const { localSelected } = useOnboardingPracticeMode();
  const user = useAuthStore((state) => state.user);
  const input = useRef<TextInput>(null);
  const draftsReady = useRef(0);
  const lastDraftAt = useRef<string | undefined>(undefined);
  // Once a draft is inserted the step is finished, so a later agent error (another regenerate, a
  // refused try) must not take it away.
  const inserted = useRef(false);
  const [phase, setPhase] = useState<Phase>('start');
  const [value, setValue] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  // A failed refinement leaves the earlier draft on the keyboard's card, so the field stays up for
  // inserting it.
  const hasDraft = phase === 'first-draft' || phase === 'refined';
  const liveAvailable = !localSelected && !!user && (!agentError || hasDraft);
  const errorIsFinal = !!agentError && agentError in FINAL_ERROR_NOTES;
  const pulse = useSharedValue(0);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pulse.value * 0.04 }] }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: pulse.value * 0.18 }));

  // Eyes are on the keyboard during the try, so each new instruction pulses the card and taps the
  // phone to draw them back up.
  useEffect(() => {
    if (phase === 'start') return;
    pulse.value = withSequence(withTiming(1, { duration: 160 }), withTiming(0, { duration: 700 }));
    safeHaptics(phase === 'done' ? 'success' : 'light');
  }, [phase, pulse]);

  useEffect(() => {
    const subscription = addKeyboardStatusChangedListener((event) => {
      if (event.status === 'recording') {
        setPhase((current) => (current === 'start' ? 'asking' : current));
      } else if (event.status === 'agent_ready') {
        // The native module emits each status directly and again from its own Darwin notification;
        // both copies carry the same updatedAtMs.
        if (event.updatedAtMs && event.updatedAtMs === lastDraftAt.current) return;
        lastDraftAt.current = event.updatedAtMs;
        draftsReady.current += 1;
        const next: Phase = draftsReady.current >= 2 ? 'refined' : 'first-draft';
        setPhase((current) => (current === 'done' ? current : next));
        setAgentError(null);
      } else if (event.status === 'agent_error') {
        if (inserted.current) return;
        setAgentError(event.error || 'agent_error');
        if (draftsReady.current === 0) Keyboard.dismiss();
      }
    });
    return () => subscription?.remove();
  }, []);

  const retry = (): void => {
    draftsReady.current = 0;
    setAgentError(null);
    setPhase('start');
    setValue('');
    input.current?.focus();
  };

  const errorNote = agentError
    ? (FINAL_ERROR_NOTES[agentError] ??
      (hasDraft
        ? 'The change didn’t go through. You can still insert this draft.'
        : 'The voice assistant couldn’t finish. Try again or skip for now.'))
    : null;
  const fallbackNote = localSelected
    ? 'The voice assistant uses Cloud. Here’s an example instead.'
    : !user
      ? 'The voice assistant needs a connection. Here’s an example instead.'
      : errorNote;

  return (
    <OnboardingShell
      title="Meet your voice assistant."
      titleAccent="voice assistant"
      subtitle="Say what you need, and it writes it for you in any app."
      progress={progress}
      onBack={goBack}
      onSkip={goNext}
      ctaLabel="Continue"
      onCta={goNext}
      secondaryCtaLabel={agentError && !errorIsFinal ? 'Retry' : undefined}
      onSecondaryCta={retry}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-4 pb-4"
      >
        {liveAvailable ? (
          <>
            <Animated.View
              style={pulseStyle}
              className="flex-row items-center gap-3 overflow-hidden rounded-2xl bg-primary/5 p-4"
            >
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, { backgroundColor: BRAND }, flashStyle]}
              />
              <SystemIcon
                name={phase === 'done' ? 'checkmark.circle.fill' : 'sparkles'}
                mdName={phase === 'done' ? 'CheckCircle2' : 'Sparkles'}
                size={20}
                color="brand"
              />
              <Text
                accessibilityLiveRegion="polite"
                accessibilityLabel={
                  phase === 'start' && !agentError
                    ? 'Tap the voice assistant button, the wand, on your keyboard.'
                    : undefined
                }
                className="flex-1 text-[16px] leading-[22px] text-label"
              >
                {INSTRUCTIONS[agentError ? 'refined' : phase]}
              </Text>
            </Animated.View>
            {errorNote ? (
              <Text
                accessibilityRole="alert"
                className={`text-[14px] leading-[20px] ${
                  errorIsFinal ? 'text-secondaryLabel' : 'text-systemRed'
                }`}
              >
                {errorNote}
              </Text>
            ) : null}
            <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground px-4 pb-4 pt-3">
              <Text className="mb-2 text-[11px] font-bold uppercase tracking-wider text-tertiaryLabel">
                To: Support
              </Text>
              <TextInput
                ref={input}
                accessibilityLabel="Your message"
                value={value}
                onChangeText={(text) => {
                  setValue(text);
                  // Only an inserted agent draft finishes the try; plain dictation into the field
                  // doesn't count.
                  if (text.trim() && draftsReady.current > 0 && phase !== 'done') {
                    inserted.current = true;
                    setPhase('done');
                    setAgentError(null);
                    Keyboard.dismiss();
                  }
                }}
                autoFocus
                multiline
                placeholder="Your draft appears here"
                placeholderTextColor="#9CA3AF"
                style={styles.messageInput}
                textAlignVertical="top"
                autoCorrect={false}
              />
            </View>
          </>
        ) : (
          <>
            <Text
              accessibilityRole={agentError ? 'alert' : undefined}
              className={`text-[14px] leading-[20px] ${
                agentError && !errorIsFinal ? 'text-systemRed' : 'text-secondaryLabel'
              }`}
            >
              {fallbackNote}
            </Text>
            <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
              <View className="flex-row items-center gap-2">
                <SystemIcon name="mic.fill" mdName="Mic" size={18} color="brand" />
                <Text className="text-[13px] font-semibold text-secondaryLabel">
                  Example request
                </Text>
              </View>
              <Text className="mt-3 text-[17px] leading-[24px] text-label">“{REQUEST}”</Text>
            </View>
            <View className="rounded-2xl bg-primary/5 p-4">
              <View className="flex-row items-center gap-2">
                <SystemIcon name="sparkles" mdName="Sparkles" size={18} color="brand" />
                <Text className="text-[13px] font-semibold text-secondaryLabel">
                  Example response
                </Text>
              </View>
              <Text className="mt-3 text-[17px] leading-[24px] text-label">{EXAMPLE_DRAFT}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  messageInput: {
    minHeight: 120,
    color: PlatformColor('label') as unknown as string,
    fontFamily: SpaceGrotesk.regular,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 22,
  },
});
