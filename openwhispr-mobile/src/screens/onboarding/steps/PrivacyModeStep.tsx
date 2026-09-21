import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
import { BRAND } from '@/config/colors';
import { useConfigStore } from '@/store/useConfigStore';
import { useAuthStore } from '@/store/useAuthStore';
import { accountRequiredForCloud } from '@/lib/accountAccess';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import type { ProcessingMode } from '@/types';

const STEP_ID = 'privacy-mode';

export function PrivacyModeStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const ensureAnonymousSession = useAuthStore((s) => s.ensureAnonymousSession);
  const cloudNeedsAccount = accountRequiredForCloud(user);
  const [selected, setSelected] = useState<ProcessingMode>('private');

  useEffect(() => {
    if (!config) loadConfig();
  }, [config, loadConfig]);

  useEffect(() => {
    // Without a session cloud can't run, so never restore it as the selection.
    if (config?.defaultMode && !(cloudNeedsAccount && config.defaultMode === 'cloud')) {
      setSelected(config.defaultMode);
    }
  }, [config?.defaultMode, cloudNeedsAccount]);

  const handleSelectCloud = useCallback(async () => {
    if (!cloudNeedsAccount) {
      setSelected('cloud');
      return;
    }

    // A guest chose to continue without an account on an earlier build; no
    // session is going to be minted for them, and they have a connection, so
    // blaming the network would be wrong.
    if (isGuest) {
      Alert.alert(
        'Cloud needs an account',
        'You chose to continue without an account, so Cloud is off for now. Finish setup in Private mode and sign in from the Account tab whenever you want Cloud.',
        [{ text: 'OK' }],
      );
      return;
    }

    // Onboarding normally already holds an anonymous session, so reaching here
    // means opening it failed — almost always no connection. Retry once before
    // refusing, rather than leaving Cloud permanently unselectable.
    await ensureAnonymousSession();
    if (!accountRequiredForCloud(useAuthStore.getState().user)) {
      setSelected('cloud');
      return;
    }

    Alert.alert(
      'Cloud is unavailable',
      'OpenWhispr Cloud needs a connection to set up. Continue with Private mode for now — you can switch later in Settings.',
      [{ text: 'OK' }],
    );
  }, [cloudNeedsAccount, ensureAnonymousSession, isGuest]);

  const handleContinue = useCallback(async () => {
    await updateConfig({ defaultMode: selected });
    // Everyone picks languages next (cloud transcription uses them too); the language
    // step then routes cloud users past the model download.
    await goNext();
  }, [selected, updateConfig, goNext]);

  return (
    <OnboardingShell
      progress={getStepProgress(STEP_ID)}
      title="How should we transcribe?"
      titleAccent="transcribe"
      subtitle="Your voice stays yours. Pick a mode — you can change it anytime."
      ctaLabel="Continue"
      onCta={handleContinue}
    >
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 12, paddingTop: 4, paddingBottom: 8 }}
      >
        <ModeCard
          selected={selected === 'private'}
          onPress={() => setSelected('private')}
          accessibilityLabel="Private mode"
          title="Private mode"
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

        <ModeCard
          selected={selected === 'cloud'}
          onPress={handleSelectCloud}
          accessibilityLabel="OpenWhispr Cloud"
          title="OpenWhispr Cloud"
          icon={<OpenWhisprMark size={20} color={BRAND} />}
        >
          <Bullet text="Faster transcription" />
          <Bullet text="Higher quality" />
          <Bullet text="Automatic cleanup & formatting" />
        </ModeCard>
      </ScrollView>
    </OnboardingShell>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View className="mt-1.5 flex-row items-center gap-1.5">
      <SystemIcon name="checkmark" mdName="Check" size={13} color="systemGreen" />
      <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">{text}</Text>
    </View>
  );
}

function ModeCard({
  selected,
  onPress,
  icon,
  title,
  accessibilityLabel,
  children,
}: {
  selected: boolean;
  onPress: () => void;
  icon: ReactNode;
  title: string;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      className={`flex-row items-start gap-3 rounded-xl border bg-secondarySystemGroupedBackground px-4 py-4 active:opacity-90 ${
        selected ? 'border-primary' : 'border-separator'
      }`}
    >
      <View className="mt-0.5 h-8 w-8 items-center justify-center">{icon}</View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label">{title}</Text>
        {children}
      </View>
      <View className="mt-0.5 h-[20px] w-[20px] items-center justify-center">
        {selected ? (
          <SystemIcon name="checkmark.circle.fill" mdName="CheckCircle2" size={20} color="brand" />
        ) : (
          <View className="h-[20px] w-[20px] rounded-full border border-separator" />
        )}
      </View>
    </Pressable>
  );
}
