import { useEffect, useRef } from 'react';
import type React from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import { getSpeakerDisplayColor, getSpeakerDisplayName } from '@/lib/diarization/transcriptDisplay';
import { useTheme } from '@/android/ThemeProvider';

export interface LiveTranscriptListProps {
  utterances: RealtimeUtterance[];
  partialText: string;
  /** Speaker label per utterance id, arriving a beat after the text. */
  speakerLabels?: Record<string, string>;
}

interface LiveTranscriptListViewProps extends LiveTranscriptListProps {
  active: boolean;
  selectable?: boolean;
}

/**
 * Live cloud-transcript view: finalized utterances as rows, plus the in-progress
 * partial in lighter grey, auto-scrolling to the
 * bottom as new text arrives. When a line's speaker is known, the speaker's name
 * shows above it wherever the speaker changes, numbered in the order people first
 * spoke, as the saved transcript numbers them.
 */
export function LiveTranscriptListView({
  utterances,
  partialText,
  speakerLabels,
  active,
  selectable,
}: LiveTranscriptListViewProps): React.JSX.Element {
  const k = useTheme().tokens;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [utterances.length, partialText]);

  const isEmpty = utterances.length === 0 && partialText.length === 0;
  const speakerOrder = new Map<string, number>();
  for (const utterance of utterances) {
    const label = speakerLabels?.[utterance.itemId];
    if (label && !speakerOrder.has(label)) speakerOrder.set(label, speakerOrder.size);
  }
  let previousSpeaker: string | undefined;

  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerStyle={{ gap: 16, paddingBottom: 8 }}
      showsVerticalScrollIndicator={false}
    >
      {isEmpty && active ? (
        <Text className="text-[15px]" style={{ color: k.tertiary }}>
          Listening… speak to see the transcript.
        </Text>
      ) : null}
      {utterances.map((utterance) => {
        const label = speakerLabels?.[utterance.itemId];
        const index = label ? speakerOrder.get(label)! : -1;
        const showSpeaker = !!label && label !== previousSpeaker;
        if (label) previousSpeaker = label;
        const color = getSpeakerDisplayColor(null, index);
        return (
          <View key={utterance.itemId} className="gap-1.5">
            {showSpeaker ? (
              <View
                className="flex-row items-center gap-2"
                testID={`live-speaker-${utterance.itemId}`}
              >
                <View className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
                <Text className="text-[14px] font-semibold" style={{ color }}>
                  {getSpeakerDisplayName(null, index)}
                </Text>
              </View>
            ) : null}
            <Text
              {...(selectable ? { selectable: true } : {})}
              className="text-[16px] leading-[23px]"
              style={{ color: k.ink }}
            >
              {utterance.text}
            </Text>
          </View>
        );
      })}
      {partialText ? (
        <Text className="text-[16px] leading-6" style={{ color: k.tertiary }}>
          {partialText}
        </Text>
      ) : null}
    </ScrollView>
  );
}
