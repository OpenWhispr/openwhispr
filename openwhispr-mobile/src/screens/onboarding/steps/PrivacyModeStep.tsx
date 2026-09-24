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
      subtitle="Your voice stays yours. Pick a mode — you can change it anytime."
      ctaLabel="Use Cloud"
      onCta={chooseCloud}
      secondaryCtaLabel="Use Local"
      secondaryCtaVariant="card"
      onSecondaryCta={() => chooseOnboardingMode('private', 'privacy-mode')}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingTop: 4, paddingBottom: 8 }}
      >
        {selectedMode ? (
          <Text className="text-[14px] font-medium text-primary">
            {selectedMode === 'cloud' ? 'Cloud is selected' : 'Local is selected'}
          </Text>
        ) : null}
        <ModeCard
          title="Local · Private mode"
          icon={<SystemIcon name="lock.fill" mdName="Lock" size={18} color="brand" />}
        >
          <Text className="mt-1 text-[14px] leading-[19px] text-secondaryLabel">
            Everything runs on your device. Nothing is ever uploaded.
          </Text>
          <Bullet text="Works fully offline" />
          <View className="mt-2 flex-row items-start gap-1.5">
            <View className="mt-px">
              <SystemIcon name="info.circle" mdName="Info" size={13} color="secondaryLabel" />
            </View>
            <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">
              No automatic cleanup or formatting — you get the raw transcription.
            </Text>
          </View>
          <Text className="mt-2 text-[12px] text-tertiaryLabel">
            One-time ~140–461 MB download, depending on language
          </Text>
        </ModeCard>
        <ModeCard title="OpenWhispr Cloud" icon={<OpenWhisprMark size={20} color={BRAND} />}>
          <Bullet text="Faster transcription" />
          <Bullet text="Higher quality" />
          <Bullet text="Automatic cleanup & formatting" />
        </ModeCard>
      </ScrollView>
    </OnboardingShell>
  );
}

function Bullet({ text }: { text: string }): ReactElement {
  return (
    <View className="mt-1.5 flex-row items-center gap-1.5">
      <SystemIcon name="checkmark" mdName="Check" size={13} color="systemGreen" />
      <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">{text}</Text>
    </View>
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
    <View className="flex-row items-start gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground px-4 py-4">
      <View className="mt-0.5 h-8 w-8 items-center justify-center">{icon}</View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label">{title}</Text>
        {children}
      </View>
    </View>
  );
}
