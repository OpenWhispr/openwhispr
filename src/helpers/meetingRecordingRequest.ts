import type { StartRecordingArgs, StartRecordingResult } from "../stores/meetingRecordingStore";

interface MeetingRecordingRequestOptions {
  args: StartRecordingArgs;
  startRecording: (args: StartRecordingArgs) => Promise<StartRecordingResult>;
  restoreFromMeetingMode: () => Promise<void> | void;
  onHandled: () => void;
  trigger?: string;
  canAutoStart?: () => boolean;
  onSuppressed?: () => Promise<void> | void;
}

export async function handleMeetingRecordingRequest({
  args,
  startRecording,
  restoreFromMeetingMode,
  onHandled,
  trigger,
  canAutoStart,
  onSuppressed,
}: MeetingRecordingRequestOptions): Promise<void> {
  let suppressed = false;
  let accepted: StartRecordingResult = false;
  const check =
    trigger === "hotkey" || !canAutoStart
      ? undefined
      : (): boolean => {
          suppressed ||= !canAutoStart();
          return !suppressed;
        };
  // Consume before setup can outlive the notes view and be replayed on remount.
  onHandled();
  if (!check || check()) {
    accepted = await startRecording(check ? { ...args, canAutoStart: check } : args);
    if (accepted === false && !suppressed) await restoreFromMeetingMode();
  }
  if (accepted === "cancelled" || (!accepted && suppressed)) return onSuppressed?.();
}
