import type { ReactElement, ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { BRAND } from '@/config/colors';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { chooseOnboardingMode } from '@/lib/onboardingMode';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';

export function PrivacyModeStep(): ReactElement {
  const { goBack, progress } = useOnboardingStep('privacy-mode');
  const selectedMode = useOnboardingStore((state) => state.selectedMode);
  const cancelActiveDownloads = useModelDownloadStore((state) => state.cancelActiveDownloads);

  const chooseCloud = async (): Promise<void> => {
    const choseLocalEarlier = selectedMode === 'private';
    await chooseOnboardingMode('cloud', 'privacy-mode');
    // Back from the download step leaves its model transferring; Cloud has no use for it. Without
    // an earlier Local choice, a running download was started from Settings and isn't ours to stop.
    if (choseLocalEarlier) await cancelActiveDownloads();
  };

  return (
    <OnboardingShell
      progress={progress}
      onBack={goBack}
      title="How should we transcribe?"
      titleAccent="transcribe"
      subtitle="Pick a mode for everyday use. You can change it anytime."
      ctaLabel="Use Cloud"
      onCta={chooseCloud}
      secondaryCtaLabel="Use Local"
      secondaryCtaVariant="card"
      onSecondaryCta={() => chooseOnboardingMode('private', 'privacy-mode')}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingBottom: 16 }}
      >
        {selectedMode ? (
          <Text className="text-[14px] font-medium text-primary">
            {selectedMode === 'cloud' ? 'Cloud is selected' : 'Local is selected'}
          </Text>
        ) : null}
        <ModeCard title="OpenWhispr Cloud" icon={<OpenWhisprMark size={22} color={BRAND} />}>
          <Text className="mt-2 text-[14px] leading-[20px] text-secondaryLabel">
            Fast, high-quality transcription with automatic cleanup and formatting. Tones and the
            voice agent are available after sign-in.
          </Text>
          <Text className="mt-3 text-[12px] leading-[17px] text-secondaryLabel">
            Next: an optional Pro offer. You can dismiss it and continue with your current limits.
          </Text>
        </ModeCard>
        <ModeCard
          title="Local · Private mode"
          icon={<SystemIcon name="lock.fill" mdName="Lock" size={22} color="brand" />}
        >
          <Text className="mt-2 text-[14px] leading-[20px] text-secondaryLabel">
            Transcription runs on your device. Nothing is uploaded, and it works offline after
            setup.
          </Text>
          <Text className="mt-2 text-[14px] leading-[20px] text-secondaryLabel">
            Raw transcription without automatic cleanup, tones, or the voice agent. Your tone choice
            is saved for Cloud.
          </Text>
          <Text className="mt-3 text-[12px] leading-[17px] text-secondaryLabel">
            One-time ~140–461 MB download, depending on language.
          </Text>
        </ModeCard>
      </ScrollView>
    </OnboardingShell>
  );
}

function ModeCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
      <View className="flex-row items-center gap-3">
        {icon}
        <Text className="flex-1 text-[18px] font-semibold text-label">{title}</Text>
      </View>
      {children}
    </View>
  );
}
