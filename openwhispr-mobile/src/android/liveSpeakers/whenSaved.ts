/**
 * Work to run the moment a live meeting's lines are saved. The shared save step
 * (`finalizeCloudMeeting`) writes the lines without speakers, marks the meeting done or failed,
 * then spends seconds writing the title; the Android notes store calls `linesSaved` from that
 * status change, so the speakers land with the lines instead of after the title.
 */
const waiting = new Map<number, () => void>();

export function whenLinesSaved(noteId: number, work: () => void): void {
  waiting.set(noteId, work);
}

export function linesSaved(noteId: number): void {
  const work = waiting.get(noteId);
  waiting.delete(noteId);
  work?.();
}

export function forgetLinesSaved(noteId: number): void {
  waiting.delete(noteId);
}
