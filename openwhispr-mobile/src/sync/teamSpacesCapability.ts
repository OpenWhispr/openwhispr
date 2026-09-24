import { notesRepository } from '@/data';

// Persisted in sync_state (shared key/value store — see notesRepository
// getSyncState/setSyncState) rather than its own table: this is a single
// session-spanning flag, not sync data with its own lifecycle.
const KEY = 'team_spaces_capability';

/**
 * Whether the deployed backend supports team spaces (GET /api/me/spaces is
 * deployed). Written by syncSpaces() after each probe/sync attempt.
 *
 * - `true` — confirmed capable; scope-aware pushes/pulls may proceed.
 * - `false` — confirmed a 404/405/501; omit all scope fields.
 * - `null` — never probed yet (no sync has run on this device/account).
 */
export function getTeamSpacesCapability(): boolean | null {
  const value = notesRepository.getSyncState(KEY);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export function setTeamSpacesCapability(capable: boolean): void {
  notesRepository.setSyncState(KEY, capable ? 'true' : 'false');
}
