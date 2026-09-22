import { View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import { useOnboardingStore } from '@/store/useOnboardingStore';

const TRUST_POINTS = [
  'No selling your data',
  'No advertising profile',
  'You control where processing happens',
];

export function SecurityFirstStep() {
  const goNext = useOnboardingStore((s) => s.goNext);

  return (
    <OnboardingShell
      title="Security-first speech to text"
      titleAccent="Security-first"
      subtitle="OpenWhispr is designed to keep your dictation private and in your control."
      ctaLabel="Continue"
      onCta={goNext}
    >
      <View className="flex-1 justify-center gap-5">
        <View className="gap-2 rounded-2xl border border-separator bg-secondarySystemGroupedBackground px-4 py-3.5">
          {TRUST_POINTS.map((point) => (
            <View key={point} className="flex-row items-center gap-2">
              <SystemIcon name="checkmark" mdName="Check" size={14} color="systemGreen" />
              <Text className="flex-1 text-[14px] leading-[19px] text-secondaryLabel">{point}</Text>
            </View>
          ))}
        </View>
      </View>
    </OnboardingShell>
  );
}
