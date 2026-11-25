import type React from 'react';
import { RecordingView } from '@/android/notes/RecordingView';
import { notesT } from '@/android/notes/strings';
import { RecordingNoteChips } from '@/android/notes/noteChips';
import { Sentry } from '@/lib/sentry';

/** A meeting recorded on the phone (Figma R1): transcribed afterwards, so Notes is the tab. */
export function LocalMeetingRecording({
  count,
  elapsedSeconds,
  keyboardHeight,
  rawNotes,
  setRawNotes,
  onStop,
  title,
  noteId,
}: {
  count: number | undefined;
  elapsedSeconds: number;
  keyboardHeight: number;
  bottomInset?: number;
  headerHeight?: number;
  rawNotes: string;
  setRawNotes: (value: string) => void;
  onStop: () => Promise<void>;
  title?: string | null;
  /** The note being recorded: its chips show and can be edited while it records. */
  noteId?: number | null;
}): React.JSX.Element {
  return (
    <RecordingView
      status="live"
      elapsedSeconds={elapsedSeconds}
      title={title?.trim() || notesT('untitled')}
      chips={count != null && count > 1 ? [notesT('people', { count })] : []}
      meta={noteId != null ? <RecordingNoteChips noteId={noteId} /> : undefined}
      rawNotes={rawNotes}
      onChangeRawNotes={setRawNotes}
      transcript={null}
      onStop={() => {
        onStop().catch(Sentry.captureException);
      }}
      keyboardHeight={keyboardHeight}
    />
  );
}
