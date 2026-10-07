import { useState, type ReactElement, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { BRAND } from '@/config/colors';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { chooseOnboardingMode } from '@/lib/onboardingMode';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';

type ModeChoice = 'cloud' | 'private';

export function PrivacyModeStep(): ReactElement {
  const { goBack, progress } = useOnboardingStep('privacy-mode');
  const selectedMode = useOnboardingStore((state) => state.selectedMode);
  const cancelActiveDownloads = useModelDownloadStore((state) => state.cancelActiveDownloads);
  // Revisiting the step keeps the earlier Local choice; otherwise Cloud is the default.
  const [choice, setChoice] = useState<ModeChoice>(
    selectedMode === 'private' ? 'private' : 'cloud',
  );

  const handleContinue = async (): Promise<void> => {
    if (choice === 'private') {
      await chooseOnboardingMode('private', 'privacy-mode');
      return;
    }
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
      ctaLabel="Continue"
      onCta={handleContinue}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingTop: 4, paddingBottom: 8 }}
      >
        <ModeCard
          title="OpenWhispr Cloud"
          icon={<OpenWhisprMark size={20} color={BRAND} />}
          selected={choice === 'cloud'}
          onSelect={() => setChoice('cloud')}
        >
          <Bullet text="Zero setup" />
          <Bullet text="Faster transcription" />
          <Bullet text="Higher quality" />
          <Bullet text="Automatic cleanup & formatting" />
        </ModeCard>
        <ModeCard
          title="Local · Private mode"
          icon={<SystemIcon name="lock.fill" mdName="Lock" size={18} color="brand" />}
          selected={choice === 'private'}
          onSelect={() => setChoice('private')}
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
  selected,
  onSelect,
  children,
}: {
  title: string;
  icon: ReactNode;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      onPress={onSelect}
      className={`flex-row items-start gap-3 rounded-xl border bg-secondarySystemGroupedBackground px-4 py-4 ${selected ? 'border-primary' : 'border-separator'}`}
    >
      <View className="mt-0.5 h-8 w-8 items-center justify-center">{icon}</View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label">{title}</Text>
        {children}
      </View>
      <SystemIcon
        name={selected ? 'checkmark.circle.fill' : 'circle'}
        mdName={selected ? 'CheckCircle2' : 'Circle'}
        size={22}
        color={selected ? 'brand' : 'tertiaryLabel'}
      />
    </Pressable>
  );
}
