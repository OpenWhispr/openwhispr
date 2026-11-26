import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { TranscriptBlock } from '@/android/shared/lib/diarization/transcriptDisplay';
import { useIosColor } from '@/android/shared/config/colors';

interface SpeakerTranscriptProps {
  blocks: TranscriptBlock[];
  selectedSpeakerId?: number | null;
  selectable?: boolean;
  onSpeakerPress?: (block: TranscriptBlock) => void;
}

export function SpeakerTranscript({
  blocks,
  selectedSpeakerId,
  selectable = false,
  onSpeakerPress,
}: SpeakerTranscriptProps) {
  const { copy } = useAndroidCopy();
  const color = useIosColor();
  if (blocks.length === 0) {
    return (
      <Text className="text-[15px]" style={{ color: color('tertiaryLabel') }}>
        {copy('noteDetails.noSegments', 'No transcript segments yet.')}
      </Text>
    );
  }

  return (
    <View className="gap-4" testID="speaker-transcript">
      {blocks.map((block) => {
        const selected = block.speakerId != null && block.speakerId === selectedSpeakerId;
        return (
          <View
            key={block.id}
            className="border-b pb-4"
            style={{ borderBottomColor: color('separator') }}
            testID={`speaker-transcript-block-${block.id}`}
          >
            <View className="mb-2 flex-row items-center gap-2">
              <View
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: block.speakerColor }}
                testID={`speaker-color-${block.id}`}
              />
              <Pressable
                disabled={!onSpeakerPress || block.speakerId == null}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={copy('noteDetails.editSpeaker', `Edit ${block.speakerName}`, {
                  name: block.speakerName,
                })}
                onPress={() => onSpeakerPress?.(block)}
                testID={`speaker-button-${block.speakerId ?? block.id}`}
                className={selected ? 'rounded-md px-1' : 'px-1'}
                style={selected ? { backgroundColor: color('tertiarySystemFill') } : undefined}
              >
                <Text className="text-[14px] font-semibold" style={{ color: block.speakerColor }}>
                  {block.speakerName}
                </Text>
              </Pressable>
              <Text className="text-[12px]" style={{ color: color('tertiaryLabel') }}>
                {block.timestamp}
              </Text>
            </View>
            <Text
              selectable={selectable}
              className="text-[16px] leading-6"
              style={{ color: color('label') }}
            >
              {block.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
