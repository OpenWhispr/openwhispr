import type React from 'react';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { RecordingView } from '@/android/notes/RecordingView';
import { notesT } from '@/android/notes/strings';
import { RecordingNoteChips } from '@/android/notes/noteChips';
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
  /** Speaker label per utterance id; lines without one show no speaker yet. */
  speakerLabels?: Record<string, string>;
  onStop: () => void;
  /** The calendar meeting it records, when one was picked (Figma R0). */
  title?: string | null;
  peopleCount?: number;
  /** The note being recorded: its chips show and can be edited while it records. */
  noteId?: number;
}

interface CloudMeetingRecordingViewProps extends CloudMeetingRecordingProps {
  stopLabel: string;
  renderTranscript: (
    utterances: RealtimeUtterance[],
    partialText: string,
    status: CloudMeetingStatus,
    speakerLabels?: Record<string, string>,
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
  speakerLabels,
  onStop,
  stopLabel,
  renderTranscript,
  title,
  peopleCount,
  noteId,
}: CloudMeetingRecordingViewProps): React.JSX.Element {
  const keyboardHeight = useKeyboardHeight();
  return (
    <RecordingView
      status={status}
      error={error}
      elapsedSeconds={elapsedSeconds}
      title={title?.trim() || notesT('recordMeeting')}
      chips={peopleCount && peopleCount > 1 ? [notesT('people', { count: peopleCount })] : []}
      meta={noteId != null ? <RecordingNoteChips noteId={noteId} /> : undefined}
      rawNotes={rawNotes}
      onChangeRawNotes={onChangeRawNotes}
      transcript={renderTranscript(utterances, partialText, status, speakerLabels)}
      stopLabel={stopLabel}
      onStop={onStop}
      keyboardHeight={keyboardHeight}
    />
  );
}
