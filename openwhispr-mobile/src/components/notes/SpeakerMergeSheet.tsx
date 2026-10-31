import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { Speaker } from '@/data/types';
import { getSpeakerDisplayColor, getSpeakerDisplayName } from '@/lib/diarization/transcriptDisplay';

interface SpeakerMergeSheetProps {
  visible: boolean;
  sourceSpeaker: Speaker | null;
  speakers: Speaker[];
  onCancel: () => void;
  onMerge: (sourceSpeakerId: number, targetSpeakerId: number) => void;
}

const hasDisplayName = (speaker: Speaker | null): boolean => !!speaker?.displayName?.trim();

const defaultTargetId = (targets: Speaker[]): number | null =>
  (targets.find((speaker) => hasDisplayName(speaker)) ?? targets[0])?.id ?? null;

export function SpeakerMergeSheet({
  visible,
  sourceSpeaker,
  speakers,
  onCancel,
  onMerge,
}: SpeakerMergeSheetProps) {
  const { copy } = useAndroidCopy();
  const targets = useMemo(
    () => speakers.filter((speaker) => speaker.id !== sourceSpeaker?.id),
    [sourceSpeaker?.id, speakers],
  );
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(defaultTargetId(targets));

  useEffect(() => {
    if (visible) setSelectedTargetId(defaultTargetId(targets));
  }, [targets, visible]);

  const selectedTarget = targets.find((speaker) => speaker.id === selectedTargetId) ?? null;
  const sourceName = sourceSpeaker
    ? getSpeakerDisplayName(sourceSpeaker, sourceSpeaker.sortOrder)
    : copy('speakerControls.thisSpeaker', 'This speaker');
  const targetName = selectedTarget
    ? getSpeakerDisplayName(selectedTarget, selectedTarget.sortOrder)
    : '';
  const shouldWarnUnnamedTarget =
    hasDisplayName(sourceSpeaker) && !!selectedTarget && !hasDisplayName(selectedTarget);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-black/30">
        <View
          className="gap-4 rounded-t-[24px] bg-systemBackground px-5 pb-8 pt-5"
          testID="speaker-merge-sheet"
        >
          <Text accessibilityRole="header" className="text-lg font-semibold text-label">
            {copy('speakerControls.mergeTitle', 'Merge speaker')}
          </Text>
          {targets.length === 0 ? (
            <Text className="text-[15px] text-secondaryLabel">
              {copy('speakerControls.noTargets', 'No other speakers to merge into.')}
            </Text>
          ) : (
            <>
              <Text className="text-[14px] leading-5 text-secondaryLabel">
                {copy(
                  'speakerControls.mergeBody',
                  `${targetName} survives. ${sourceName} disappears and its transcript moves into ${targetName}.`,
                  { target: targetName, source: sourceName },
                )}
              </Text>
              {shouldWarnUnnamedTarget ? (
                <Text className="text-[13px] leading-5 text-systemRed">
                  {copy(
                    'speakerControls.unnamedWarning',
                    'The surviving speaker does not have a custom name.',
                  )}
                </Text>
              ) : null}
              <View className="gap-2">
                {targets.map((speaker) => {
                  const name = getSpeakerDisplayName(speaker, speaker.sortOrder);
                  const selected = speaker.id === selectedTargetId;
                  return (
                    <Pressable
                      key={speaker.id}
                      onPress={() => setSelectedTargetId(speaker.id)}
                      className={
                        (Platform.OS === 'android'
                          ? 'min-h-12 flex-row items-center gap-3 rounded-lg border px-3 py-3 '
                          : 'h-12 flex-row items-center gap-3 rounded-lg border px-3 ') +
                        (selected
                          ? 'border-brand bg-tertiarySystemFill'
                          : 'border-separator bg-secondarySystemBackground')
                      }
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={copy('speakerControls.mergeInto', `Merge into ${name}`, {
                        name,
                      })}
                      testID={`speaker-merge-target-${speaker.id}`}
                    >
                      <View
                        className="h-3 w-3 rounded-full"
                        style={{
                          backgroundColor: getSpeakerDisplayColor(speaker, speaker.sortOrder),
                        }}
                      />
                      <Text className="flex-1 text-[15px] font-medium text-label">{name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}
          <View className="flex-row gap-3">
            <Pressable
              onPress={onCancel}
              className={
                Platform.OS === 'android'
                  ? 'min-h-12 flex-1 items-center justify-center rounded-lg bg-tertiarySystemFill px-3 py-3'
                  : 'h-11 flex-1 items-center justify-center rounded-lg bg-tertiarySystemFill'
              }
              accessibilityRole="button"
              accessibilityLabel={copy('speakerControls.cancelMerge', 'Cancel merge')}
              testID="speaker-merge-cancel"
            >
              <Text className="text-[15px] font-medium text-label">{copy('cancel', 'Cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (sourceSpeaker && selectedTargetId != null) {
                  onMerge(sourceSpeaker.id, selectedTargetId);
                }
              }}
              disabled={!sourceSpeaker || selectedTargetId == null}
              className={
                Platform.OS === 'android'
                  ? 'min-h-12 flex-1 items-center justify-center rounded-lg bg-brand px-3 py-3'
                  : 'h-11 flex-1 items-center justify-center rounded-lg bg-brand'
              }
              accessibilityRole="button"
              accessibilityLabel={copy('speakerControls.confirmMerge', 'Confirm speaker merge')}
              testID="speaker-merge-confirm"
              style={({ pressed }) => ({
                opacity: !sourceSpeaker || selectedTargetId == null ? 0.4 : pressed ? 0.75 : 1,
              })}
            >
              <Text className="text-[15px] font-semibold text-white">
                {copy('speakerControls.mergeAction', 'Merge')}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
