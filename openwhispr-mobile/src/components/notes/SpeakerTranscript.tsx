import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';

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
  if (blocks.length === 0) {
    return <Text className="text-[15px] text-tertiaryLabel">No transcript segments yet.</Text>;
  }

  return (
    <View className="gap-4" testID="speaker-transcript">
      {blocks.map((block) => {
        const selected = block.speakerId != null && block.speakerId === selectedSpeakerId;
        return (
          <View
            key={block.id}
            className="border-b border-separator/40 pb-4"
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
                accessibilityLabel={`Edit ${block.speakerName}`}
                onPress={() => onSpeakerPress?.(block)}
                testID={`speaker-button-${block.speakerId ?? block.id}`}
                className={selected ? 'rounded-md bg-tertiarySystemFill px-1' : 'px-1'}
              >
                <Text className="text-[14px] font-semibold" style={{ color: block.speakerColor }}>
                  {block.speakerName}
                </Text>
              </Pressable>
              <Text className="text-[12px] text-tertiaryLabel">{block.timestamp}</Text>
            </View>
            <Text selectable={selectable} className="text-[16px] leading-6 text-label">
              {block.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
