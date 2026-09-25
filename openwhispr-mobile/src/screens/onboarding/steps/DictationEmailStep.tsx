import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Image,
  Keyboard,
  PlatformColor,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { AppFont } from '@/lib/fonts';
import { OnboardingError } from '@/lib/onboardingErrors';
import { useOnboardingPracticeMode } from '@/hooks/useOnboardingPracticeMode';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useAuthStore } from '@/store/useAuthStore';
import { useHandoffStore } from '@/store/useHandoffStore';
import { addKeyboardStatusChangedListener } from '../../../../modules/app-group-storage/src';

const SAMPLE_EMAIL =
  'Hey Tim, excited to chat. Are you free next Friday at 3pm… actually, 4pm? Thanks, Chad';

const GMAIL_ICON = require('../../../../assets/onboarding/app-icons/gmail.png');
const MAIL_ICON = require('../../../../assets/onboarding/app-icons/mail.png');
const OUTLOOK_ICON = require('../../../../assets/onboarding/app-icons/outlook.png');

export function DictationEmailStep(): ReactElement {
  const { goNext, progress } = useOnboardingStep('dictation-email');
  const { localSelected } = useOnboardingPracticeMode();
  const user = useAuthStore((state) => state.user);
  const ensureSession = useAuthStore((state) => state.ensureAnonymousSession);
  const isTranscribing = useHandoffStore((state) => state.isTranscribing);
  const input = useRef<TextInput>(null);
  const dismissOnInsert = useRef(false);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);
  const liveAvailable = !localSelected && !!user;
  const busy =
    status === 'recording' || status === 'transcribing' || status === 'cleaning' || isTranscribing;

  useEffect(() => {
    const subscription = addKeyboardStatusChangedListener((event) => {
      if (!event.status) return;
      setStatus(event.status);
      if (event.status === 'ready') dismissOnInsert.current = true;
      if (
        event.status === 'error' ||
        event.status === 'no_speech' ||
        event.status === 'setup_required'
      ) {
        setError(
          event.status === 'no_speech'
            ? 'No speech detected. Try again.'
            : event.error || 'Dictation could not finish. Try again.',
        );
        Keyboard.dismiss();
      } else if (event.status === 'recording') {
        // The keyboard settles back to idle after a failure, so only a new attempt clears it.
        setError(null);
      }
    });
    return () => subscription?.remove();
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    await ensureSession();
    if (!useAuthStore.getState().user)
      throw new OnboardingError('Still no connection. Check it and try again, or skip for now.');
    setError(null);
    setStatus('idle');
    setValue('');
    input.current?.focus();
  }, [ensureSession]);

  const note = localSelected
    ? 'Practice uses Cloud. Skip it to keep Local.'
    : !user
      ? 'Cloud practice needs a connection. Try again or skip for now.'
      : status === 'recording'
        ? 'Listening…'
        : busy
          ? 'Transcribing…'
          : value.trim()
            ? 'Your email is ready'
            : 'Tap the field, then the keyboard mic. Practice uses Cloud.';

  return (
    <OnboardingShell
      progress={progress}
      onSkip={busy ? undefined : goNext}
      title="Try dictating an email"
      titleAccent="email"
      subtitle="Don't type — just talk naturally. OpenWhispr formats it for you."
      ctaLabel="Continue"
      ctaDisabled={busy}
      onCta={goNext}
      secondaryCtaLabel={!localSelected && (error || !user) ? 'Retry' : undefined}
      onSecondaryCta={retry}
    >
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {/* Compose-style card — a light email hint (To / Subject), not a real client */}
        <View className="overflow-hidden rounded-2xl border border-separator bg-secondarySystemGroupedBackground">
          <View className="flex-row items-center gap-3 border-b border-separator px-4 py-3">
            <Text className="w-16 text-[14px] text-tertiaryLabel">To</Text>
            <View className="flex-row items-center gap-1.5 rounded-full bg-quaternarySystemFill py-1 pl-1 pr-2.5">
              <View className="h-5 w-5 items-center justify-center rounded-full bg-brand">
                <Text className="text-[10px] font-bold text-white">T</Text>
              </View>
              <Text className="text-[13px] font-semibold text-label">Tim</Text>
            </View>
          </View>
          <View className="flex-row items-center gap-3 border-b border-separator px-4 py-3">
            <Text className="w-16 text-[14px] text-tertiaryLabel">Subject</Text>
            <Text className="text-[14px] font-medium text-label">Quick sync</Text>
          </View>
          <View className="px-4 pb-4 pt-3">
            <Text className="mb-2 text-[11px] font-bold uppercase tracking-wider text-tertiaryLabel">
              Read this aloud
            </Text>
            <TextInput
              ref={input}
              accessibilityLabel="Your dictated email"
              value={value}
              onChangeText={(text) => {
                setValue(text);
                // Native readiness precedes the keyboard consuming its pending transcript, and the
                // status stays ready afterwards, so dismiss once per dictation, not on every edit.
                if (dismissOnInsert.current && text.trim()) {
                  dismissOnInsert.current = false;
                  Keyboard.dismiss();
                }
              }}
              editable={liveAvailable}
              autoFocus={liveAvailable}
              multiline
              placeholder={SAMPLE_EMAIL}
              placeholderTextColor="#9CA3AF"
              style={styles.emailInput}
              textAlignVertical="top"
              autoCorrect={false}
              scrollEnabled
            />
          </View>
        </View>

        <Text
          accessibilityRole={error ? 'alert' : undefined}
          accessibilityLiveRegion="polite"
          className={`mt-3 text-[13px] ${error ? 'text-systemRed' : 'text-secondaryLabel'}`}
        >
          {error ?? note}
        </Text>

        {/* Reassurance — works anywhere */}
        <View className="mt-4 flex-row items-center justify-center">
          <AppIcon source={GMAIL_ICON} size={18} />
          <AppIcon source={MAIL_ICON} size={16} overlap />
          <AppIcon source={OUTLOOK_ICON} size={27} overlap />
          <Text className="ml-2.5 text-[12px] text-tertiaryLabel">works in any email app</Text>
        </View>
      </ScrollView>
    </OnboardingShell>
  );
}

function AppIcon({
  source,
  overlap,
  size = 18,
}: {
  source: ImageSourcePropType;
  overlap?: boolean;
  size?: number;
}): ReactElement {
  return (
    <View
      className={`h-7 w-7 items-center justify-center overflow-hidden rounded-full border-2 border-systemBackground bg-white ${
        overlap ? '-ml-2.5' : ''
      }`}
    >
      <Image source={source} resizeMode="contain" style={{ height: size, width: size }} />
    </View>
  );
}

const styles = StyleSheet.create({
  emailInput: {
    minHeight: 140,
    color: PlatformColor('label') as unknown as string,
    fontFamily: AppFont.regular,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 22,
  },
});
