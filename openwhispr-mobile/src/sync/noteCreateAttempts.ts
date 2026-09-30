import { notesRepository, type Note } from '@/data';

const KEY = 'notes.create_attempts';

function readAttempts(): string[] {
  const stored = notesRepository.getSyncState(KEY);
  return stored ? (JSON.parse(stored) as string[]) : [];
}

// Persist before sending: a lost response must remain recoverable after relaunch.
export function recordNoteCreateAttempts(clientIds: string[]): void {
  notesRepository.setSyncState(
    KEY,
    JSON.stringify([...new Set([...readAttempts(), ...clientIds])]),
  );
}

export function forgetNoteCreateAttempts(clientIds: string[]): void {
  const remaining = readAttempts().filter((clientId) => !clientIds.includes(clientId));
  if (remaining.length) notesRepository.setSyncState(KEY, JSON.stringify(remaining));
  else clearNoteCreateAttempts();
}

export function clearNoteCreateAttempts(): void {
  notesRepository.clearSyncState(KEY);
}

export function mayHaveCloudCopy(note: Pick<Note, 'remoteId' | 'clientNoteId'>): boolean {
  return Boolean(
    note.remoteId || (note.clientNoteId && readAttempts().includes(note.clientNoteId)),
  );
}
