import {
  CloudMeetingRecordingView,
  type CloudMeetingRecordingProps,
} from './CloudMeetingRecordingView';
import { LiveTranscriptList } from './LiveTranscriptList.android';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { CloudMeetingStatus } from '@/hooks/useCloudMeeting';

const footerPadding = (keyboardHeight: number, bottomInset: number) =>
  keyboardHeight > 0 ? 12 : Math.max(bottomInset + 16, 24);

const renderTranscript = (
  utterances: RealtimeUtterance[],
  partialText: string,
  status: CloudMeetingStatus,
) => (
  <LiveTranscriptList
    utterances={utterances}
    partialText={partialText}
    active={status !== 'error'}
  />
);

export function CloudMeetingRecording({
  stopLabel = 'Stop',
  ...props
}: CloudMeetingRecordingProps & { stopLabel?: string }) {
  return (
    <CloudMeetingRecordingView
      {...props}
      stopLabel={stopLabel}
      footerPadding={footerPadding}
      renderTranscript={renderTranscript}
    />
  );
}
