import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { BRAND } from '@/config/colors';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { canRunLocalReasoning, getLocalReasoningReadiness } from '@/lib/localReasoning';
import { chooseOnboardingMode } from '@/lib/onboardingMode';
import { useConfigStore } from '@/store/useConfigStore';
import { useModelDownloadStore } from '@/store/useModelDownloadStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import type { InferenceMode, LocalReasoningReadiness } from '@/types';

type ModeChoice = 'cloud' | 'private';

type CleanupLine = { included: boolean; text: string; hint?: string };

// What Private Mode's cleanup does on this phone, matching what choosing it saves
// (chooseOnboardingMode): a cleanup provider saved earlier keeps cleaning, and otherwise it's
// Apple Intelligence or nothing. On an iPhone nothing is shown until the check answers.
function privateCleanupLine(
  readiness: LocalReasoningReadiness | null,
  savedCleanup: InferenceMode | undefined,
): CleanupLine | null {
  if (savedCleanup === 'providers') {
    return {
      included: true,
      text: 'Cleanup with your saved provider',
      hint: 'Your transcription is sent to the provider you chose in AI Models.',
    };
  }
  if (Platform.OS !== 'ios') {
    return {
      included: false,
      text: 'No automatic cleanup',
      hint: 'You’ll get the raw transcription.',
    };
  }
  if (canRunLocalReasoning(readiness)) {
    return {
      included: true,
      text: 'Cleanup with Apple Intelligence',
      hint:
        readiness?.status === 'appleIntelligenceOff'
          ? 'Starts once it’s on in Settings → Apple Intelligence & Siri.'
          : undefined,
    };
  }
  if (readiness?.status === 'unsupportedDevice') {
    return {
      included: false,
      text: 'No cleanup on this iPhone',
      hint: 'Needs Apple Intelligence (iPhone 15 Pro or later). You’ll get the raw transcription.',
    };
  }
  if (readiness?.status === 'unsupportedOS') {
    return {
      included: false,
      text: 'No cleanup on this iPhone yet',
      hint: 'Needs iOS 26 on an iPhone with Apple Intelligence. Until then, you’ll get the raw transcription.',
    };
  }
  return null;
}

export function PrivacyModeStep(): ReactElement {
  const { goBack, progress } = useOnboardingStep('privacy-mode');
  const selectedMode = useOnboardingStore((state) => state.selectedMode);
  const cancelActiveDownloads = useModelDownloadStore((state) => state.cancelActiveDownloads);
  // Revisiting the step keeps the earlier Local choice; otherwise Cloud is the default.
  const [choice, setChoice] = useState<ModeChoice>(
    selectedMode === 'private' ? 'private' : 'cloud',
  );
  const [readiness, setReadiness] = useState<LocalReasoningReadiness | null>(null);
  useEffect(() => {
    let cancelled = false;
    getLocalReasoningReadiness().then((result) => {
      if (!cancelled) setReadiness(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const savedCleanup = useConfigStore((state) => state.config?.inference?.cleanup?.mode);
  const cleanupLine = privateCleanupLine(readiness, savedCleanup);

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
          title="Private Mode"
          icon={<SystemIcon name="lock.fill" mdName="Lock" size={18} color="brand" />}
          selected={choice === 'private'}
          onSelect={() => setChoice('private')}
        >
          <Text className="mt-1 text-[14px] leading-[19px] text-secondaryLabel">
            Everything runs on your device. Nothing is ever uploaded.
          </Text>
          <Bullet text="Works fully offline" />
          {cleanupLine ? <Bullet {...cleanupLine} /> : null}
          <Text className="mt-2 text-[12px] text-tertiaryLabel">
            One-time ~140–461 MB download, depending on language
          </Text>
        </ModeCard>
      </ScrollView>
    </OnboardingShell>
  );
}

// A check for what the mode includes, a dash for what it doesn't, with an optional reason below.
function Bullet({
  text,
  included = true,
  hint,
}: {
  text: string;
  included?: boolean;
  hint?: string;
}): ReactElement {
  return (
    <View className="mt-1.5">
      <View className="flex-row items-center gap-1.5">
        <SystemIcon
          name={included ? 'checkmark' : 'minus'}
          mdName={included ? 'Check' : 'Minus'}
          size={13}
          color={included ? 'systemGreen' : 'tertiaryLabel'}
        />
        <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">{text}</Text>
      </View>
      {hint ? (
        <Text className="ml-[19px] mt-0.5 text-[12px] leading-[16px] text-tertiaryLabel">
          {hint}
        </Text>
      ) : null}
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
