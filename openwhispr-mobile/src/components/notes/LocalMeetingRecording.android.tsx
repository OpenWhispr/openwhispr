import type React from 'react';
import { RecordingView } from '@/android/notes/RecordingView';
import { notesT } from '@/android/notes/strings';
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
}): React.JSX.Element {
  return (
    <RecordingView
      status="live"
      elapsedSeconds={elapsedSeconds}
      title={title?.trim() || notesT('recordMeeting')}
      chips={[
        notesT('onPhone'),
        ...(count != null && count > 1 ? [notesT('people', { count })] : []),
      ]}
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
