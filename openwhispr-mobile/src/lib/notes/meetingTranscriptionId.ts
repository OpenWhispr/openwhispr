import type { NotesRepository } from '@/data/types';
import { randomUUID } from '@/lib/uuid';

export const meetingTranscriptionIdKey = (noteId: number): string =>
  `meeting.transcription_id:${noteId}`;

export function getMeetingTranscriptionId(
  repository: Pick<NotesRepository, 'getSyncState' | 'setSyncState'>,
  noteId: number,
): string {
  // The account's database owns this identity. Persist it before uploading, so
  // retries after a failed chunk or process restart reuse the same usage rows.
  const key = meetingTranscriptionIdKey(noteId);
  const existing = repository.getSyncState(key);
  if (existing) return existing;
  const id = randomUUID();
  repository.setSyncState(key, id);
  return id;
}
