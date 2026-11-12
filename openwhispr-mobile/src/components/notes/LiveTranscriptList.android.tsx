import {
  LiveTranscriptListView,
  type LiveTranscriptListProps,
} from './LiveTranscriptListView.android';

export function LiveTranscriptList({
  utterances,
  partialText,
  active = true,
}: LiveTranscriptListProps & { active?: boolean }) {
  return (
    <LiveTranscriptListView
      utterances={utterances}
      partialText={partialText}
      active={active}
      selectable
    />
  );
}
