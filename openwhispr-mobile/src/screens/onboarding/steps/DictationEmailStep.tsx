import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Keyboard, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SpaceGrotesk } from '@/lib/fonts';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useHandoffStore } from '@/store/useHandoffStore';
import { addKeyboardStatusChangedListener } from '../../../../modules/app-group-storage/src';

const SAMPLE_EMAIL =
  'Hey Tim, excited to chat. Are you free next Friday at 3pm… actually, 4pm? Thanks, Chad';
const EXAMPLE_EMAIL =
  'Hey Tim,\n\nExcited to chat! Are you free next Friday at 4 pm?\n\nThanks,\nChad';

export function DictationEmailStep(): ReactElement {
  const { goNext, progress } = useOnboardingStep('dictation-email');
  const selectedMode = useOnboardingStore((state) => state.selectedMode);
  const user = useAuthStore((state) => state.user);
  const ensureSession = useAuthStore((state) => state.ensureAnonymousSession);
  const isTranscribing = useHandoffStore((state) => state.isTranscribing);
  const input = useRef<TextInput>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);
  const [showExample, setShowExample] = useState(false);
  const localSelected = selectedMode === 'private';
  const liveAvailable = !localSelected && !!user;
  const busy =
    status === 'recording' || status === 'transcribing' || status === 'cleaning' || isTranscribing;

  useEffect(() => {
    // Practice may use Cloud before the choice, but must never override a Local choice.
    if (selectedMode !== null) return;
    const previous = useProcessingModeStore.getState();
    previous.setActiveMode('cloud', true);
    return () => {
      useProcessingModeStore.getState().setActiveMode(previous.activeMode, previous.isUserOverride);
    };
  }, [selectedMode]);

  useEffect(() => {
    const subscription = addKeyboardStatusChangedListener((event) => {
      if (!event.status) return;
      setStatus(event.status);
      if (
        event.status === 'error' ||
        event.status === 'no_speech' ||
        event.status === 'setup_required'
      ) {
        setError(
          event.status === 'no_speech'
            ? 'No speech detected. Try again or view the example.'
            : event.error || 'Dictation could not finish. Try again or view the example.',
        );
        Keyboard.dismiss();
      } else {
        setError(null);
      }
    });
    return () => subscription?.remove();
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    await ensureSession();
    if (!useAuthStore.getState().user)
      throw new Error('Cloud practice needs a connection. You can view the example or skip.');
    setError(null);
    setStatus('idle');
    setShowExample(false);
    setValue('');
    input.current?.focus();
  }, [ensureSession]);

  const statusLabel =
    status === 'recording'
      ? 'Listening…'
      : busy
        ? 'Transcribing…'
        : value.trim()
          ? 'Your email is ready'
          : 'Tap the field, then the keyboard microphone';

  return (
    <OnboardingShell
      avoidKeyboard
      progress={progress}
      onSkip={busy ? undefined : goNext}
      title="Try dictating an email"
      titleAccent="email"
      subtitle={
        localSelected
          ? 'Local is still selected. Here is an example of Cloud cleanup.'
          : 'This practice uses Cloud. You’ll choose Cloud or Local after the previews.'
      }
      ctaLabel="Continue"
      ctaDisabled={busy}
      onCta={goNext}
      secondaryCtaLabel={!localSelected && (error || !user) ? 'Retry' : undefined}
      onSecondaryCta={retry}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 16, gap: 12 }}
      >
        <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
          <Text className="text-[12px] font-semibold text-secondaryLabel">Read this aloud</Text>
          <Text className="mt-2 text-[15px] leading-[21px] text-label">{SAMPLE_EMAIL}</Text>
        </View>
        <View className="rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
          <Text className="text-[12px] font-semibold text-secondaryLabel">
            To: Tim · Quick sync
          </Text>
          <TextInput
            ref={input}
            accessibilityLabel="Your dictated email"
            value={value}
            onChangeText={(text) => {
              setValue(text);
              // Native readiness precedes the keyboard consuming its pending transcript.
              if (status === 'ready' && text.trim()) Keyboard.dismiss();
            }}
            editable={liveAvailable}
            multiline
            placeholder="Your words appear here"
            className="mt-3 text-label placeholder:text-tertiaryLabel"
            style={{
              minHeight: 100,
              fontFamily: SpaceGrotesk.regular,
              fontSize: 16,
              lineHeight: 22,
            }}
            textAlignVertical="top"
            autoCorrect={false}
          />
        </View>
        {liveAvailable ? (
          <Text accessibilityLiveRegion="polite" className="text-[14px] text-secondaryLabel">
            {statusLabel}
          </Text>
        ) : null}
        {error || (!localSelected && !user) ? (
          <Text accessibilityRole="alert" className="text-[14px] text-systemRed">
            {error || 'Cloud practice needs a connection. View the example or skip for now.'}
          </Text>
        ) : null}
        {showExample || localSelected ? (
          <View className="rounded-xl bg-primary/5 p-4">
            <Text className="text-[12px] font-semibold text-secondaryLabel">
              Example · not a live transcription
            </Text>
            <Text className="mt-2 text-[15px] leading-[21px] text-label">{EXAMPLE_EMAIL}</Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            accessibilityState={{ disabled: busy }}
            onPress={() => {
              Keyboard.dismiss();
              setShowExample(true);
            }}
            className="py-2"
          >
            <Text className="text-[15px] text-primary">Show an example</Text>
          </Pressable>
        )}
      </ScrollView>
    </OnboardingShell>
  );
}
