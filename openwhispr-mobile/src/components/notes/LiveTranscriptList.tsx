import { LiveTranscriptListView, type LiveTranscriptListProps } from './LiveTranscriptListView';

export function LiveTranscriptList({ utterances, partialText }: LiveTranscriptListProps) {
  return <LiveTranscriptListView utterances={utterances} partialText={partialText} active />;
}
