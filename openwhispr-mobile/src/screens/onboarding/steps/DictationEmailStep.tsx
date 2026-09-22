import { useEffect, useRef, useState } from 'react';
import {
  Image,
  Keyboard,
  PlatformColor,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SpaceGrotesk } from '@/lib/fonts';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { useHandoffStore } from '@/store/useHandoffStore';

const STEP_ID = 'dictation-email';

const SAMPLE_EMAIL = `Hey Tim, excited to chat. Are you free next Friday at 3pm… actually, 4pm? Thanks, Chad`;

const GMAIL_ICON = require('../../../../assets/onboarding/app-icons/gmail.png');
const MAIL_ICON = require('../../../../assets/onboarding/app-icons/mail.png');
const OUTLOOK_ICON = require('../../../../assets/onboarding/app-icons/outlook.png');

export function DictationEmailStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const [value, setValue] = useState('');

  // Auto-hide the keyboard the moment a dictation finishes — scoped to this step
  // only, so the transcribed email and the Continue button are immediately visible.
  // Everywhere else the keyboard stays up for continuous dictation. Dictation into
  // this in-app field is "self-hosted", so useHandoffStore.isActive never flips;
  // isTranscribing is the flag that toggles true→false as the transcript lands.
  const isTranscribing = useHandoffStore((s) => s.isTranscribing);
  const wasTranscribing = useRef(false);

  useEffect(() => {
    if (wasTranscribing.current && !isTranscribing) {
      Keyboard.dismiss();
    }
    wasTranscribing.current = isTranscribing;
  }, [isTranscribing]);

  return (
    <OnboardingShell
      progress={getStepProgress(STEP_ID)}
      onSkip={goNext}
      title="Try dictating an email"
      titleAccent="email"
      subtitle="Don't type — just talk naturally. OpenWhispr formats it for you."
      ctaLabel="Continue"
      onCta={goNext}
    >
      <Pressable className="flex-1" onPress={Keyboard.dismiss}>
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
              value={value}
              onChangeText={setValue}
              multiline
              placeholder={SAMPLE_EMAIL}
              placeholderTextColor="#9CA3AF"
              style={styles.emailInput}
              textAlignVertical="top"
              autoCorrect={false}
              autoFocus
              scrollEnabled
            />
          </View>
        </View>

        {/* Reassurance — works anywhere */}
        <View className="mt-4 flex-row items-center justify-center">
          <AppIcon source={GMAIL_ICON} size={18} />
          <AppIcon source={MAIL_ICON} size={16} overlap />
          <AppIcon source={OUTLOOK_ICON} size={27} overlap />
          <Text className="ml-2.5 text-[12px] text-tertiaryLabel">works in any email app</Text>
        </View>
      </Pressable>
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
}) {
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
    fontFamily: SpaceGrotesk.regular,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 22,
  },
});
