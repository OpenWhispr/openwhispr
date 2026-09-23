import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Keyboard, PlatformColor, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingPracticeMode } from '@/hooks/useOnboardingPracticeMode';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { SpaceGrotesk } from '@/lib/fonts';
import { useAuthStore } from '@/store/useAuthStore';
import { addKeyboardStatusChangedListener } from '../../../../modules/app-group-storage/src';

type Phase = 'start' | 'asking' | 'first-draft' | 'refined' | 'done';

const INSTRUCTIONS: Record<Phase, string> = {
  start: 'Tap the field, then the ✨ agent button on your keyboard.',
  asking: 'Say: “Write a message inviting Sam to lunch tomorrow at noon.”',
  'first-draft': 'Now tap Ask for changes and say: “Make this more concise.”',
  refined: 'Tap ✓ to insert it.',
  done: 'That’s your voice agent.',
};

// The agent reports this once an anonymous user's free tries are used up; only an account clears it.
const ACCOUNT_REQUIRED = 'account_required';

export function VoiceAgentStep(): ReactElement {
  const { goNext, goBack, progress } = useOnboardingStep('voice-agent');
  const { localSelected } = useOnboardingPracticeMode();
  const user = useAuthStore((state) => state.user);
  const input = useRef<TextInput>(null);
  const draftsReady = useRef(0);
  const [phase, setPhase] = useState<Phase>('start');
  const [value, setValue] = useState('');
  const [agentError, setAgentError] = useState<string | null>(null);
  const liveAvailable = !localSelected && !!user && !agentError;

  useEffect(() => {
    const subscription = addKeyboardStatusChangedListener((event) => {
      if (event.status === 'recording') {
        setPhase((current) => (current === 'start' ? 'asking' : current));
      } else if (event.status === 'agent_ready') {
        draftsReady.current += 1;
        const next: Phase = draftsReady.current >= 2 ? 'refined' : 'first-draft';
        setPhase((current) => (current === 'done' ? current : next));
      } else if (event.status === 'agent_error') {
        setAgentError(event.error || 'agent_error');
        Keyboard.dismiss();
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

  const fallbackNote = localSelected
    ? 'The voice agent uses Cloud. Here’s an example instead.'
    : !user
      ? 'The voice agent needs a connection. Here’s an example instead.'
      : agentError === ACCOUNT_REQUIRED
        ? 'You’ve used the free tries. Sign in at the end to keep using the agent.'
        : 'The agent couldn’t finish. Try again or skip for now.';

  return (
    <OnboardingShell
      avoidKeyboard
      title="Meet your voice agent."
      titleAccent="voice agent"
      subtitle="Ask for what you need, then refine it by voice."
      progress={progress}
      onBack={goBack}
      onSkip={goNext}
      ctaLabel="Continue"
      onCta={goNext}
      secondaryCtaLabel={agentError && agentError !== ACCOUNT_REQUIRED ? 'Retry' : undefined}
      onSecondaryCta={retry}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-4 pb-4"
      >
        {liveAvailable ? (
          <>
            <View className="flex-row items-center gap-3 rounded-2xl bg-primary/5 p-4">
              <SystemIcon
                name={phase === 'done' ? 'checkmark.circle.fill' : 'sparkles'}
                mdName={phase === 'done' ? 'CheckCircle2' : 'Sparkles'}
                size={20}
                color="brand"
              />
              <Text
                accessibilityLiveRegion="polite"
                className="flex-1 text-[16px] leading-[22px] text-label"
              >
                {INSTRUCTIONS[phase]}
              </Text>
            </View>
            <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground px-4 pb-4 pt-3">
              <Text className="mb-2 text-[11px] font-bold uppercase tracking-wider text-tertiaryLabel">
                To: Sam
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
                    setPhase('done');
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
                agentError && agentError !== ACCOUNT_REQUIRED
                  ? 'text-systemRed'
                  : 'text-secondaryLabel'
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
              <Text className="mt-3 text-[17px] leading-[24px] text-label">
                “Write a message inviting Sam to lunch tomorrow at noon.”
              </Text>
            </View>
            <View className="rounded-2xl bg-primary/5 p-4">
              <View className="flex-row items-center gap-2">
                <SystemIcon name="sparkles" mdName="Sparkles" size={18} color="brand" />
                <Text className="text-[13px] font-semibold text-secondaryLabel">
                  Example response
                </Text>
              </View>
              <Text className="mt-3 text-[17px] leading-[24px] text-label">
                Hey Sam, are you free for lunch tomorrow? Let’s meet at noon if that works for you.
              </Text>
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
