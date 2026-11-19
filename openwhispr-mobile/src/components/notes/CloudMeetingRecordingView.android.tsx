import type React from 'react';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { RecordingView } from '@/android/notes/RecordingView';
import { notesT } from '@/android/notes/strings';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { CloudMeetingStatus } from '@/hooks/useCloudMeeting';

export interface CloudMeetingRecordingProps {
  status: CloudMeetingStatus;
  error: string | null;
  elapsedSeconds: number;
  rawNotes: string;
  onChangeRawNotes: (text: string) => void;
  utterances: RealtimeUtterance[];
  partialText: string;
  onStop: () => void;
  /** The calendar meeting it records, when one was picked (Figma R0). */
  title?: string | null;
  peopleCount?: number;
}

interface CloudMeetingRecordingViewProps extends CloudMeetingRecordingProps {
  stopLabel: string;
  renderTranscript: (
    utterances: RealtimeUtterance[],
    partialText: string,
    status: CloudMeetingStatus,
  ) => React.ReactNode;
}

/** Android's live Cloud recording in the Notes design (Figma R1). */
export function CloudMeetingRecordingView({
  status,
  error,
  elapsedSeconds,
  rawNotes,
  onChangeRawNotes,
  utterances,
  partialText,
  onStop,
  stopLabel,
  renderTranscript,
  title,
  peopleCount,
}: CloudMeetingRecordingViewProps): React.JSX.Element {
  const keyboardHeight = useKeyboardHeight();
  return (
    <RecordingView
      status={status}
      error={error}
      elapsedSeconds={elapsedSeconds}
      title={title?.trim() || notesT('recordMeeting')}
      chips={[
        notesT('liveOnCloud'),
        ...(peopleCount && peopleCount > 1 ? [notesT('people', { count: peopleCount })] : []),
      ]}
      rawNotes={rawNotes}
      onChangeRawNotes={onChangeRawNotes}
      transcript={renderTranscript(utterances, partialText, status)}
      stopLabel={stopLabel}
      onStop={onStop}
      keyboardHeight={keyboardHeight}
    />
  );
}
