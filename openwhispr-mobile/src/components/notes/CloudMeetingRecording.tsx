import {
  CloudMeetingRecordingView,
  type CloudMeetingRecordingProps,
} from './CloudMeetingRecordingView';
import { LiveTranscriptList } from './LiveTranscriptList';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

const footerPadding = (keyboardHeight: number, bottomInset: number) =>
  keyboardHeight > 0 ? keyboardHeight + 12 : Math.max(bottomInset + 16, 24);

const renderTranscript = (utterances: RealtimeUtterance[], partialText: string) => (
  <LiveTranscriptList utterances={utterances} partialText={partialText} />
);

export function CloudMeetingRecording(props: CloudMeetingRecordingProps) {
  return (
    <CloudMeetingRecordingView
      {...props}
      stopLabel="Stop"
      footerPadding={footerPadding}
      renderTranscript={renderTranscript}
    />
  );
}
