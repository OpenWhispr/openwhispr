import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { formatSpeakingTime, type VoiceSetupCandidate } from '@/lib/notes/voiceSetupPrompt';

const CLAIMED_MESSAGE = 'Your next on-device meetings will label you as Me.';

interface ThatsMeSheetProps {
  visible: boolean;
  candidates: VoiceSetupCandidate[];
  /** True once your voice profile is saved. */
  onClaim: (speakerId: number) => boolean;
  onReadScript: () => void;
  onClose: () => void;
  /** iOS only: the sheet has finished sliding away. */
  onDismissed?: () => void;
}

export function ThatsMeSheet({
  visible,
  candidates,
  onClaim,
  onReadScript,
  onClose,
  onDismissed,
}: ThatsMeSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [claimed, setClaimed] = useState(false);
  // Two taps can land before the list re-renders. Once a claim has saved, a second one
  // would fail against the new owner profile and undo the success state.
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    claimedRef.current = false;
    setClaimed(false);
  }, [visible]);

  const claim = (speakerId: number): void => {
    if (claimedRef.current) return;
    if (!onClaim(speakerId)) return;
    claimedRef.current = true;
    setClaimed(true);
    // The button that had focus is gone, so say what happened.
    AccessibilityInfo.announceForAccessibility(`Got it. ${CLAIMED_MESSAGE}`);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <View className="flex-1 bg-systemBackground" testID="thats-me-sheet">
        <View className="flex-row items-start justify-between gap-4 px-6 pb-4 pt-8">
          <View className="flex-1">
            <Text accessibilityRole="header" className="text-[22px] font-bold text-label">
              Teach OpenWhispr your voice
            </Text>
            {claimed ? null : (
              <>
                <Text className="mt-1 text-[15px] leading-5 text-secondaryLabel">
                  Which speaker is you?
                </Text>
                <Text className="mt-2 text-[13px] leading-[18px] text-tertiaryLabel">
                  We'll use your voice from this meeting to make a voice profile. It stays on this
                  device and is only used to recognize you in meetings you record. You can delete it
                  in Voice Profiles.
                </Text>
              </>
            )}
          </View>
          <GlassIconButton onPress={onClose} accessibilityLabel="Close">
            <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
          </GlassIconButton>
        </View>

        {claimed ? (
          <View className="gap-3 px-6">
            <Text className="text-[22px] font-semibold text-label">Got it</Text>
            <Text className="text-[15px] leading-5 text-secondaryLabel">{CLAIMED_MESSAGE}</Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              testID="thats-me-done"
              className="mt-2 h-11 items-center justify-center rounded-lg bg-brand"
              style={{ borderCurve: 'continuous' }}
            >
              <Text className="text-[15px] font-semibold text-white">Done</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView
            contentContainerClassName="gap-3 px-6"
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          >
            {candidates.length === 0 ? (
              <Text className="text-[15px] leading-5 text-secondaryLabel">
                There's no voice sample from this meeting to use. Read a short script instead; it
                takes about 20 seconds.
              </Text>
            ) : (
              candidates.map((candidate) => (
                <View
                  key={candidate.speakerId}
                  className="flex-row items-center gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-3"
                  style={{ borderCurve: 'continuous' }}
                >
                  <View className="min-w-0 flex-1">
                    <Text className="text-[16px] font-semibold text-label">{candidate.name}</Text>
                    <Text className="text-[13px] text-secondaryLabel">
                      {`Spoke for ${formatSpeakingTime(candidate.speechMs)}`}
                    </Text>
                    {candidate.sampleLine ? (
                      <Text numberOfLines={1} className="mt-1 text-[14px] text-label">
                        {`“${candidate.sampleLine}”`}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => claim(candidate.speakerId)}
                    accessibilityRole="button"
                    accessibilityLabel={`${candidate.name} is me`}
                    testID={`thats-me-${candidate.speakerId}`}
                    className="h-11 items-center justify-center rounded-lg bg-brand px-3"
                    style={({ pressed }) => ({
                      opacity: pressed ? 0.85 : 1,
                      borderCurve: 'continuous',
                    })}
                  >
                    <Text className="text-[14px] font-semibold text-white">That's me</Text>
                  </Pressable>
                </View>
              ))
            )}
            <Pressable
              onPress={onReadScript}
              accessibilityRole="button"
              testID="thats-me-read-script"
              className="min-h-11 items-center justify-center py-2"
            >
              <Text className="text-[15px] font-medium text-brand">
                Read a short script instead
              </Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
