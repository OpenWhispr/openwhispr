import { useEffect, useRef } from 'react';
import type React from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { BRAND } from '@/config/colors';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

interface LiveTranscriptListProps {
  utterances: RealtimeUtterance[];
  partialText: string;
}

/**
 * Live cloud-transcript view: finalized utterances as rows, plus the in-progress
 * partial in lighter grey with a "Transcribing…" tail, auto-scrolling to the
 * bottom as new text arrives. Rows are unlabeled — OpenAI realtime transcription
 * returns no speaker labels (row styling is intentionally simple, pending a call).
 */
export function LiveTranscriptList({
  utterances,
  partialText,
}: LiveTranscriptListProps): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [utterances.length, partialText]);

  const isEmpty = utterances.length === 0 && partialText.length === 0;

  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1"
      contentContainerStyle={{ gap: 16, paddingBottom: 8 }}
      showsVerticalScrollIndicator={false}
    >
      {isEmpty ? (
        <Text className="text-[15px] text-tertiaryLabel">
          Listening… speak to see the transcript.
        </Text>
      ) : null}
      {utterances.map((utterance) => (
        <Text key={utterance.itemId} className="text-[16px] leading-6 text-label">
          {utterance.text}
        </Text>
      ))}
      {partialText ? (
        <Text className="text-[16px] leading-6 text-tertiaryLabel">{partialText}</Text>
      ) : null}
      {!isEmpty ? (
        <View className="flex-row items-center gap-2 pb-2">
          <View className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: BRAND }} />
          <Text className="text-[13px] font-medium text-secondaryLabel">Transcribing…</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
