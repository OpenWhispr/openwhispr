import { useState, type ReactElement } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { KEYBOARD_TONES, DEFAULT_KEYBOARD_TONE } from '@/lib/keyboardTone';
import { saveOnboardingConfig } from '@/lib/onboardingMode';
import { useConfigStore } from '@/store/useConfigStore';
import type { KeyboardTone } from '@/types';

const EXAMPLES: Record<KeyboardTone, string> = {
  default: 'Hey Sam, are you free for lunch tomorrow? Let’s meet at noon if that works for you.',
  formal:
    'Hi Sam, would you be available for lunch tomorrow at noon? Please let me know if that time is convenient.',
  casual: 'Hey Sam, want to grab lunch tomorrow? Let’s do noon if that works for you.',
  very_casual: 'hey sam, lunch tomorrow? noon work for you?',
  excited: 'Hey Sam! Want to grab lunch tomorrow? Let’s meet at noon if that works for you!',
};

export function ToneStep(): ReactElement {
  const { goNext, goBack, progress } = useOnboardingStep('tone');
  const savedTone = useConfigStore((state) => state.config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE);
  const [selected, setSelected] = useState<KeyboardTone>(savedTone);
  const [saving, setSaving] = useState(false);

  const handleContinue = async (): Promise<void> => {
    setSaving(true);
    try {
      // Config subscriptions mirror this saved choice into the keyboard's App Group.
      await saveOnboardingConfig({ keyboardTone: selected });
      await goNext();
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingShell
      title="Make it sound like you."
      titleAccent="you"
      subtitle="Choose how your keyboard dictation sounds. You can change your tone anytime."
      progress={progress}
      onBack={goBack}
      onSkip={goNext}
      ctaLabel="Continue"
      onCta={handleContinue}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingBottom: 16 }}
      >
        <View className="rounded-xl bg-secondarySystemGroupedBackground p-4">
          <Text className="text-[13px] font-semibold text-secondaryLabel">Compare the tones</Text>
          <Text className="mt-2 text-[15px] leading-[21px] text-label">
            The same lunch invitation, written five different ways.
          </Text>
          <Text className="mt-2 text-[12px] leading-[17px] text-secondaryLabel">
            These are illustrative examples. Live tones need Cloud, Dictation Cleanup, and an
            account. You can choose Local after this preview.
          </Text>
        </View>
        {KEYBOARD_TONES.map((tone) => (
          <Pressable
            key={tone.value}
            accessibilityRole="radio"
            accessibilityLabel={`${tone.label}. ${tone.description}. Example: ${EXAMPLES[tone.value]}`}
            accessibilityState={{ selected: selected === tone.value, disabled: saving }}
            disabled={saving}
            onPress={() => setSelected(tone.value)}
            className={`rounded-2xl border p-4 bg-secondarySystemGroupedBackground ${selected === tone.value ? 'border-primary' : 'border-separator'}`}
          >
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-[20px] font-semibold text-label">{tone.label}</Text>
              <SystemIcon
                name={selected === tone.value ? 'checkmark.circle.fill' : 'circle'}
                mdName={selected === tone.value ? 'CheckCircle2' : 'Circle'}
                size={22}
                color={selected === tone.value ? 'brand' : 'tertiaryLabel'}
              />
            </View>
            <Text className="mt-1 text-[14px] text-secondaryLabel">{tone.description}</Text>
            <View className="mt-4 flex-row items-start gap-3 rounded-xl bg-primary/5 p-3">
              <View className="h-8 w-8 items-center justify-center rounded-full bg-primary/15">
                <Text className="text-[13px] font-semibold text-primary">S</Text>
              </View>
              <Text className="flex-1 text-[15px] leading-[21px] text-label">
                {EXAMPLES[tone.value]}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </OnboardingShell>
  );
}
