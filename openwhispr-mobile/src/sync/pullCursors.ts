import { notesRepository } from '@/data';
import { resetTeamCursors } from './teamCursors';

// The personal pull cursors, kept next to the team ones (teamCursors.ts) for
// the same reason: the pull files read them and the reset below clears them,
// so a single definition is what stops the two from drifting.
export const NOTES_CURSOR_KEY = 'notes.last_sync_at';
export const FOLDERS_CURSOR_KEY = 'folders.last_sync_at';
export const DICTIONARY_CURSOR_KEY = 'dictionary.last_sync_at';
export const DICTIONARY_CURSOR_ID_KEY = 'dictionary.last_sync_id';
// One-time flag: before it is set, the personal dictionary pull replays the
// snapshot (then its usual delta) so rows a cursor already passed pick up their
// shared_at.
export const DICTIONARY_SHARED_AT_BACKFILL_KEY = 'dictionary.shared_at_backfill';
export const SNIPPETS_CURSOR_KEY = 'snippets.last_sync_at';
export const SNIPPETS_CURSOR_ID_KEY = 'snippets.last_sync_id';
// The shared dictionary pull (pullSharedDictionary.ts): entries and the
// member's hides page independently. The state itself lives under
// `shared_dictionary.state` (sharedDictionaryState.ts).
export const SHARED_DICTIONARY_CURSOR_KEY = 'shared_dictionary.last_sync_at';
export const SHARED_DICTIONARY_CURSOR_ID_KEY = 'shared_dictionary.last_sync_id';
export const SHARED_DICTIONARY_HIDES_CURSOR_KEY = 'shared_dictionary.hides_last_sync_at';
export const SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY = 'shared_dictionary.hides_last_sync_id';

/** Forgets the shared dictionary cursors, so its next pull is a snapshot. */
export function resetSharedDictionaryCursors(): void {
  for (const key of [
    SHARED_DICTIONARY_CURSOR_KEY,
    SHARED_DICTIONARY_CURSOR_ID_KEY,
    SHARED_DICTIONARY_HIDES_CURSOR_KEY,
    SHARED_DICTIONARY_HIDES_CURSOR_ID_KEY,
  ]) {
    notesRepository.clearSyncState(key);
  }
}

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
  resetSharedDictionaryCursors();
  resetTeamCursors();
}
