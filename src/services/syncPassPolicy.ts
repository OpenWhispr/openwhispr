// Pure decision logic for sync passes, kept out of SyncService so the
// node --test suite can cover it (the cloudSyncGuards.js precedent, #1290).

export interface PullCursorAdvance {
  // The pass's own cursor ("lastSyncedAt.<kind>", or ".<kind>.team" on a
  // team-only pass).
  advanceCursor: boolean;
  // The ".<kind>.team" cursor a full pull also covers.
  advanceTeamCursor: boolean;
}

// A backfill snapshot never sees tombstones or stubs, and a pass with
// parked/failed rows must re-see them, so neither advances any cursor. An
// unresolved note conflict is not parked: its cloud copy lives in the durable
// conflict registry and must not hold back unrelated deltas. A
// team-capable pass (or one with no team spaces at all) fully covered its
// scope: advance its own cursor, and after a full pull keep the team cursor
// current too so a later backup-off pass doesn't re-pull from the distant
// past. A degraded (own-rows-only) full pull still fully covered personal
// rows, so its cursor may advance; the untouched team cursor lets the
// recovery pull catch up on teammate edits made during the outage.
export function resolvePullCursorAdvance(pass: {
  snapshot: boolean;
  parked: boolean;
  teamOnly: boolean;
  teamCapable: boolean;
  hasTeamSpaces: boolean;
}): PullCursorAdvance {
  if (pass.snapshot || pass.parked) {
    return { advanceCursor: false, advanceTeamCursor: false };
  }
  if (pass.teamCapable || !pass.hasTeamSpaces) {
    return { advanceCursor: true, advanceTeamCursor: !pass.teamOnly };
  }
  return { advanceCursor: !pass.teamOnly, advanceTeamCursor: false };
}

// Why a space was purged locally: "deleted" covers the delete race the guard
// was built for (the server may not have processed the delete yet, so the
// space can still appear live); "revoked" covers access loss, where the space
// reappearing in /api/me/spaces means the member was re-added and the guard
// must stand down instead of locking them out for the TTL (D14).
export type PurgedSpaceReason = "revoked" | "deleted";

export interface PurgedSpaceEntry {
  at: number;
  reason: PurgedSpaceReason;
}

// Entries written before the reason field existed are plain timestamps; read
// them as "deleted" (the conservative guard) so an in-flight delete stays
// covered — at worst a pre-upgrade revocation entry rides out its TTL once.
export function normalizePurgedSpaceEntries(
  raw: Record<string, number | PurgedSpaceEntry>
): Record<string, PurgedSpaceEntry> {
  return Object.fromEntries(
    Object.entries(raw).map(([id, entry]) => [
      id,
      typeof entry === "number" ? { at: entry, reason: "deleted" as const } : entry,
    ])
  );
}

// Entries older than the TTL are dropped so a failed space delete cannot hide
// a still-live space forever.
export function prunePurgedSpaceEntries(
  entries: Record<string, PurgedSpaceEntry>,
  now: number,
  ttlMs: number
): Record<string, PurgedSpaceEntry> {
  return Object.fromEntries(Object.entries(entries).filter(([, { at }]) => now - at < ttlMs));
}

// Live-set sweep after a spaces pass. Gone from /api/me/spaces → the purge is
// confirmed server-side, guard done (either reason). Still live + "deleted" →
// the delete hasn't landed; keep guarding. Still live + "revoked" → the space
// reappeared after a re-add: drop the entry so it can re-mirror.
export function keepPurgedSpaceEntry(entry: PurgedSpaceEntry, isLive: boolean): boolean {
  return isLive && entry.reason === "deleted";
}

/**
 * Resolve a pulled note's cloud folder without ever crossing local space
 * boundaries. Team notes fall back to their space root; personal notes retain
 * the legacy default-folder fallback.
 */
export function resolvePulledNoteFolderId(
  cloudNote: { space_id?: string | null; folder_id?: string | null },
  localSpaceId: number,
  cloudToLocal: Map<string, { id: number; space_id: number }>,
  defaultFolderId: number | null
): number | null {
  const fallback = cloudNote.space_id ? null : defaultFolderId;
  const mapped = cloudNote.folder_id ? cloudToLocal.get(cloudNote.folder_id) : undefined;
  return mapped && mapped.space_id === localSpaceId ? mapped.id : fallback;
}

export interface RevokedNoteFork {
  update: {
    space_id?: number;
    folder_id?: null;
    client_note_id?: string;
    cloud_id: null;
    cloud_updated_at: null;
    owner_user_id: null;
    updated_by_user_id: null;
    left_team?: 0;
  };
  relocated: boolean;
}

// Update applied to a team note whose access was revoked (plan §7.2): move it
// to the private space (unless it already sits there, e.g. a left_team row or
// one just relocated by its folder's stub — those keep their folder link),
// drop the cloud link, and fork the client identity so the next push
// re-creates it as a new personal note. Push-side rejections fork the
// identity only when a server row exists (cloud_id) and clear the pending
// left_team retraction the server will never accept. Every new identity also
// drops the old server revision/owner/editor metadata; the pull-side
// access_removed stub always forks — the server row exists by construction.
export function revokedNoteForkUpdate(
  note: { space_id: number; cloud_id?: string | null },
  privateSpaceId: number,
  source: "push" | "pull"
): RevokedNoteFork {
  const relocated = note.space_id !== privateSpaceId;
  return {
    relocated,
    update: {
      ...(relocated ? { space_id: privateSpaceId, folder_id: null } : {}),
      ...(source === "pull" || note.cloud_id ? { client_note_id: crypto.randomUUID() } : {}),
      cloud_id: null,
      cloud_updated_at: null,
      owner_user_id: null,
      updated_by_user_id: null,
      ...(source === "push" ? { left_team: 0 as const } : {}),
    },
  };
}

// Terminal access errors from space write checks: membership revoked (403),
// space archived (410) or space gone (404). The API's sync endpoints still
// emit the legacy team_* names; the canonical space_* names replace them once
// the compatibility bridge is removed. Both families classify identically so
// the desktop recovers the same way (fork dirty rows to Personal, settle
// tombstones) regardless of which side of the rollout the API is on.
const SPACE_ACCESS_ERROR_CODES = new Set([
  "team_not_found",
  "team_access_revoked",
  "team_archived",
  "space_not_found",
  "space_access_revoked",
  "space_archived",
]);

export function isSpaceAccessErrorCode(code: string | undefined): boolean {
  return code !== undefined && SPACE_ACCESS_ERROR_CODES.has(code);
}

// Typed per-row permission denials (the caller keeps space access but lacks
// the right to this operation: delete a teammate's note, change its scope, or
// move/delete a space folder). Terminal like the access errors — retrying can
// never succeed — but recovered differently: the server row is untouched, so
// the local copy is restored from a snapshot pull instead of being settled.
const PERMISSION_DENIAL_CODES = new Set([
  "note_access_denied",
  "note_scope_change_denied",
  "folder_access_denied",
]);

export function isPermissionDenialCode(code: string | undefined): boolean {
  return code !== undefined && PERMISSION_DENIAL_CODES.has(code);
}

// Whether a pulled note should copy its cloud owner onto the local row. Kept
// independent of the last-write-wins upsert: an unchanged note (same
// updated_at) skips the content upsert but must still gain an owner, or
// pre-owner_user_id rows would fail closed in the UI forever. Stubs carry no
// user_id and tombstoned rows are about to be deleted locally.
export function shouldSetOwnerFromCloud(
  cloudNote: {
    user_id?: string | null;
    deleted_at?: string | null;
    access_removed?: boolean;
  },
  local: { owner_user_id?: string | null } | null
): boolean {
  return (
    !!local &&
    !cloudNote.access_removed &&
    !cloudNote.deleted_at &&
    cloudNote.user_id != null &&
    local.owner_user_id !== cloudNote.user_id
  );
}

// Consecutive-404 tracking for note/folder update (PATCH) pushes. A bare 404
// on an update push is ambiguous — the row was deleted server-side, or the
// pusher lost access. For notes, a revoked member's PATCH now returns a bare
// 404 (the server hides the note so its id can't be probed) rather than 403
// team_access_revoked; for folders the revoked case is already coded
// (team_not_found / team_access_revoked, caught by isSpaceAccessError), so a
// bare 404 there is a genuine-delete race. Either way we do NOT fork to
// Personal on the first 404: the same pass's pull disambiguates a revocation
// (access_removed stub → fork, preserving edits) from a deletion (tombstone →
// local delete). Only after `threshold` consecutive passes 404 with no pull
// signal do we fork as a fallback, so a stub that never lands can't 404-loop
// forever. The residual risk is a hard-delete race resurrecting the row as a
// private copy — preferred over silently discarding the user's unpushed edits.
// Counts are keyed by client id and mutated only inside the SYNC_ALL_LOCK pass.
export const UPDATE_404_FORK_THRESHOLD = 3;

export interface Update404Decision {
  // Fork to Personal now: the threshold of stub-less passes has been reached.
  fork: boolean;
  // The counts map to persist (a fresh object; the input is never mutated).
  next: Record<string, number>;
}

// Record a 404 on `clientId`'s update push and decide whether to fork. Forks
// (clearing the entry) once `threshold` prior passes have already 404'd without
// the pull resolving the row; otherwise increments and defers to the pull.
export function recordUpdate404(
  counts: Record<string, number>,
  clientId: string,
  threshold: number
): Update404Decision {
  const prior = counts[clientId] ?? 0;
  const next = { ...counts };
  if (prior >= threshold) {
    delete next[clientId];
    return { fork: true, next };
  }
  next[clientId] = prior + 1;
  return { fork: false, next };
}

// Drop `clientId`'s streak — the pull resolved it (fork or delete) or a later
// push settled. Returns the same reference when nothing changed so the caller
// can skip the localStorage write.
export function clearUpdate404(
  counts: Record<string, number>,
  clientId: string
): Record<string, number> {
  if (!(clientId in counts)) return counts;
  const next = { ...counts };
  delete next[clientId];
  return next;
}
