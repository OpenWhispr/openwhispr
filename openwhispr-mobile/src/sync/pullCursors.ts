import { notesRepository } from '@/data';
import { resetTeamCursors } from './teamCursors';

// The personal pull cursors, kept next to the team ones (teamCursors.ts) for
// the same reason: the pull files read them and the reset below clears them,
// so a single definition is what stops the two from drifting.
export const NOTES_CURSOR_KEY = 'notes.last_sync_at';
export const FOLDERS_CURSOR_KEY = 'folders.last_sync_at';
export const DICTIONARY_CURSOR_KEY = 'dictionary.last_sync_at';
export const DICTIONARY_CURSOR_ID_KEY = 'dictionary.last_sync_id';
export const SNIPPETS_CURSOR_KEY = 'snippets.last_sync_at';
export const SNIPPETS_CURSOR_ID_KEY = 'snippets.last_sync_id';

/**
 * Forgets every pull cursor so the next run replays from epoch. Used when an
 * anonymous onboarding session links to an account: the cursors were advanced
 * while pulling the anonymous user's rows, and carrying them into an account
 * that may already have older notes would hide those notes for good.
 */
export function resetAllPullCursors(): void {
  for (const key of [
    NOTES_CURSOR_KEY,
    FOLDERS_CURSOR_KEY,
    DICTIONARY_CURSOR_KEY,
    DICTIONARY_CURSOR_ID_KEY,
    SNIPPETS_CURSOR_KEY,
    SNIPPETS_CURSOR_ID_KEY,
  ]) {
    notesRepository.clearSyncState(key);
  }
  resetTeamCursors();
}
