import type { ReactElement } from 'react';
import { ScrollView, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';

export function VoiceAgentStep(): ReactElement {
  const { goNext, goBack, progress } = useOnboardingStep('voice-agent');

  return (
    <OnboardingShell
      title="Meet your voice agent."
      titleAccent="voice agent"
      subtitle="Say what you need. OpenWhispr turns your request into a draft."
      progress={progress}
      onBack={goBack}
      onSkip={goNext}
      ctaLabel="Continue"
      onCta={goNext}
    >
      <ScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-4 pb-4">
        <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
          <View className="flex-row items-center gap-2">
            <SystemIcon name="mic.fill" mdName="Mic" size={18} color="brand" />
            <Text className="text-[13px] font-semibold text-secondaryLabel">Example request</Text>
          </View>
          <Text className="mt-3 text-[17px] leading-[24px] text-label">
            “OpenWhispr, write a message inviting Sam to lunch tomorrow at noon.”
          </Text>
        </View>
        <View className="rounded-2xl bg-primary/5 p-4">
          <View className="flex-row items-center gap-2">
            <SystemIcon name="sparkles" mdName="Sparkles" size={18} color="brand" />
            <Text className="text-[13px] font-semibold text-secondaryLabel">Example response</Text>
          </View>
          <Text className="mt-3 text-[17px] leading-[24px] text-label">
            Hey Sam, are you free for lunch tomorrow? Let’s meet at noon if that works for you.
          </Text>
        </View>
        <Text className="text-[13px] leading-[19px] text-secondaryLabel">
          This is an example, not a recording. The voice agent uses Cloud and requires sign-in.
        </Text>
      </ScrollView>
    </OnboardingShell>
  );
}
