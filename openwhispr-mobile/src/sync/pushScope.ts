import { spacesRepository } from '@/data';
import { getTeamSpacesCapability } from './teamSpacesCapability';
import type { Space } from '@/data';

/**
 * Scope fields sent alongside a note/folder push body. `workspace_id` is never
 * trusted server-side (it is derived from the space row) but is still sent for
 * symmetry with desktop. An explicit `space_id: null` is how "move this row out
 * of its space, back to personal" is expressed — omitting the field instead
 * tells the server to leave the stored scope alone.
 *
 * Who actually sends them (see the call sites):
 * - note creates and folder creates: always.
 * - note updates: only when the payload also carries `base_updated_at`. Scope
 *   is a claim about a row another device may have moved since we last synced,
 *   and only the base makes that claim conditional; unguarded, a queued local
 *   edit could reverse a teammate's move.
 * - folder updates: never. Folders have no `base_updated_at` to guard with, and
 *   mobile has no folder-move feature, so there is nothing to communicate —
 *   omitting the keys leaves the server's scope untouched.
 */
export interface PushScopeFields {
  workspace_id?: string | null;
  space_id?: string | null;
}

/**
 * Resolves a row's local `space_id` into the scope fields its push should
 * carry, or `null` when the row must not push at all this pass.
 */
export type PushScopeResolver = (localSpaceId: number | null) => PushScopeFields | null;

/**
 * Builds the resolver for one push pass (capability and space rows are read
 * once, not per row).
 *
 * - Capability is anything but `true` (unprobed, or a backend that predates
 *   spaces): every row pushes with NO scope fields at all. An old server must
 *   never see them, and an absent `space_id` leaves the stored scope untouched.
 * - Team space with a cloud id: its identity travels with the row.
 * - Team space still waiting for its cloud id (a skeleton mirrored before its
 *   backfill completed): `null` — the caller skips the row, leaving pendingSync
 *   set so it pushes on a later pass. Filing it as personal would silently
 *   yank it out of the space.
 * - A space id that no longer resolves: also `null`. The row points at a space
 *   this device just lost (syncSpaces soft-deletes a revoked space earlier in
 *   the same run, so this state is reachable, not theoretical). Sending explicit
 *   nulls there would claim "move this out of its space" for content we no
 *   longer have any authority over; skipping leaves the row pending until the
 *   team pull's access-removed stub forks it or the next syncSpaces restores
 *   the space.
 * - The private space, or a row with no space at all: explicit nulls, which is
 *   what propagates a local move back to personal.
 */
export function createPushScopeResolver(): PushScopeResolver {
  if (getTeamSpacesCapability() !== true) {
    return () => ({});
  }

  const byId = new Map<number, Space>();
  for (const space of spacesRepository.listSpaces()) byId.set(space.id, space);

  return (localSpaceId: number | null): PushScopeFields | null => {
    if (localSpaceId == null) return { workspace_id: null, space_id: null };
    const space = byId.get(localSpaceId);
    if (!space) return null;
    if (space.kind !== 'team') return { workspace_id: null, space_id: null };
    if (!space.cloudSpaceId) return null;
    return { workspace_id: space.workspaceId, space_id: space.cloudSpaceId };
  };
}

/**
 * Builds a row's "team-ness" test for the `teamOnly` push filter (see
 * pushFolders.ts / pushNotes.ts): a row is team-scoped exactly when its local
 * `space_id` resolves to a space with `kind === 'team'`. A space that no
 * longer resolves (revoked and soft-deleted by syncSpaces earlier in the
 * same run) is not team-scoped for this purpose — same "unresolvable ⇒ not
 * pushable this pass" stance createPushScopeResolver takes.
 */
export function createTeamSpaceFilter(): (localSpaceId: number | null) => boolean {
  const teamSpaceIds = new Set(
    spacesRepository
      .listSpaces()
      .filter((space) => space.kind === 'team')
      .map((space) => space.id),
  );
  return (localSpaceId: number | null): boolean =>
    localSpaceId != null && teamSpaceIds.has(localSpaceId);
}
