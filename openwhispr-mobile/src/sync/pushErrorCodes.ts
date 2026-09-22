/**
 * `ApiError.code` values the sync write endpoints use to reject a push for
 * scope reasons, shared by pushNotes.ts and pushFolders.ts. Both files stay
 * duck-typed (they never import ApiError), so these work on a plain code
 * string read off the thrown error.
 */

// The caller lost the whole space: it is gone (404), membership was revoked
// (403), or it was archived (410). The API currently emits the legacy team_*
// names on sync writes and will switch to the canonical space_* names at the
// same statuses (see the backend's LEGACY_TEAM_ERROR_CODES bridge), so both
// families must classify identically — a client that only understood one side
// would retry the other forever.
const SPACE_ACCESS_CODES = new Set([
  'team_not_found',
  'team_access_revoked',
  'team_archived',
  'space_not_found',
  'space_access_revoked',
  'space_archived',
]);

/** True for any of the six space-access codes (legacy team_* and canonical space_*). */
export function isSpaceAccessCode(code: string | undefined): boolean {
  return code !== undefined && SPACE_ACCESS_CODES.has(code);
}

// Per-row permission denials (403): space access is intact, but the caller may
// not perform this particular write — edit a teammate's note, change a note's
// scope, or touch a space folder. Terminal like the space-access family, but
// recovered differently: the server row was never modified, so the local
// attempt is dropped and server truth is re-pulled instead.
const PERMISSION_DENIAL_CODES = new Set([
  'note_access_denied',
  'note_scope_change_denied',
  'folder_access_denied',
]);

/** True for note_access_denied / note_scope_change_denied / folder_access_denied. */
export function isPermissionDenialCode(code: string | undefined): boolean {
  return code !== undefined && PERMISSION_DENIAL_CODES.has(code);
}

/**
 * A folder create/rename collided with a same-named folder in the target
 * scope (409). Deliberately NOT terminal: the user (or another device) renames
 * one of the two and the retry then succeeds.
 */
export const FOLDER_NAME_TAKEN_CODE = 'folder_name_taken';
