// A meeting owns the audio session for its whole length; a second microphone would disturb it.
export const MEETING_RECORDING_REFUSAL = 'A meeting is being recorded. End it to dictate.';

export function isMeetingRecordingRefusal(error: unknown): boolean {
  return error instanceof Error && error.message === MEETING_RECORDING_REFUSAL;
}
