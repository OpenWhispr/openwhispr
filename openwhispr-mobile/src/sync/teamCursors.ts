import { notesRepository } from '@/data';

// Single source of truth for the team passes' cursors. The pull files read
// them; the push files reset them (see resetTeamCursors), so keeping the key
// strings in one place is what stops the two sides from silently drifting.
export const TEAM_NOTES_CURSOR_KEY = 'notes.team.last_sync_at';
export const TEAM_NOTES_CURSOR_ID_KEY = 'notes.team.last_sync_id';
export const TEAM_FOLDERS_CURSOR_KEY = 'folders.team.last_sync_at';

/**
 * Forgets how far the team pulls have crawled, so the next team pass replays
 * from epoch. Used only by permission-denial recovery (rare): the server
 * refused a write this device believed it was allowed to make, which means our
 * mirror of team content is wrong in ways a delta cursor can never surface.
 *
 * Removes the keys outright rather than blanking them — a device that has
 * never synced reads `null` here, and that is exactly the crawl we want back.
 */
export function resetTeamCursors(): void {
  notesRepository.clearSyncState(TEAM_NOTES_CURSOR_KEY);
  notesRepository.clearSyncState(TEAM_NOTES_CURSOR_ID_KEY);
  notesRepository.clearSyncState(TEAM_FOLDERS_CURSOR_KEY);
}
