import type { StartRecordingArgs } from "../stores/meetingRecordingStore";

interface MeetingRecordingRequestOptions {
  args: StartRecordingArgs;
  startRecording: (args: StartRecordingArgs) => Promise<boolean>;
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
  let accepted = false;
  const check =
    trigger === "hotkey" || !canAutoStart
      ? undefined
      : (): boolean => {
          suppressed ||= !canAutoStart();
          return !suppressed;
        };
  try {
    if (!check || check()) {
      accepted = await startRecording(check ? { ...args, canAutoStart: check } : args);
      if (!accepted && !suppressed) await restoreFromMeetingMode();
    }
  } finally {
    onHandled();
  }
  if (!accepted && suppressed) return onSuppressed?.();
}
