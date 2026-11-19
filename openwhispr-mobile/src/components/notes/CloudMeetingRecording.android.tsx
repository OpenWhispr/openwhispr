import {
  CloudMeetingRecordingView,
  type CloudMeetingRecordingProps,
} from './CloudMeetingRecordingView.android';
import { LiveTranscriptList } from './LiveTranscriptList.android';
import { notesT } from '@/android/notes/strings';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { CloudMeetingStatus } from '@/hooks/useCloudMeeting';

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
  stopLabel = notesT('stopAndSave'),
  ...props
}: CloudMeetingRecordingProps & { stopLabel?: string }) {
  return (
    <CloudMeetingRecordingView
      {...props}
      stopLabel={stopLabel}
      renderTranscript={renderTranscript}
    />
  );
}
