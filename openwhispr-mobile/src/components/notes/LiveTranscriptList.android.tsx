import {
  LiveTranscriptListView,
  type LiveTranscriptListProps,
} from './LiveTranscriptListView.android';

export function LiveTranscriptList({
  utterances,
  partialText,
  speakerLabels,
  active = true,
}: LiveTranscriptListProps & { active?: boolean }) {
  return (
    <LiveTranscriptListView
      utterances={utterances}
      partialText={partialText}
      speakerLabels={speakerLabels}
      active={active}
      selectable
    />
  );
}
