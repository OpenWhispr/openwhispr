import type { spaces } from '@/db/schema';

export type Space = typeof spaces.$inferSelect;
export type SpaceKind = 'private' | 'team';
export type SpaceMyRole = 'admin' | 'member';
export type SpaceSyncStatus = 'synced' | 'pending';

/** Server-shaped space row mirroring a GET /api/me/spaces list entry. */
export interface RemoteSpace {
  id: string;
  workspace_id: string;
  name: string;
  slug?: string;
  description?: string | null;
  emoji?: string | null;
  my_role: string;
  member_count?: number;
  teams?: unknown[];
  created_at?: string;
  updated_at?: string;
}

export interface SpacesRepository {
  /** Throws if missing — the migration guarantees exactly one exists. */
  getPrivateSpace(): Space;
  /** All spaces excluding soft-deleted ones. */
  listSpaces(): Space[];
  getByCloudId(cloudSpaceId: string): Space | null;
  /**
   * Matches an existing local space by `cloud_space_id`.
   *
   * - No match: inserts a new row with `sync_status: 'pending'` (a skeleton
   *   space whose content backfill hasn't completed yet).
   * - Match, not soft-deleted (routine metadata update — e.g. a rename or
   *   role change from a regular sync pass): updates
   *   name/emoji/my_role/member_count/teams/workspace_id in place and leaves
   *   `sync_status` untouched. Since the spaces sync pass calls this for
   *   every space on every run, resetting `sync_status` here would make it
   *   permanently 'pending'.
   * - Match, soft-deleted (resurrection — e.g. this device lost access to the
   *   space and was later re-added): same field updates, plus clears
   *   `deleted_at` and resets `sync_status: 'pending'`, since
   *   `softDeleteByCloudId`'s caller purged whatever content backfill had
   *   completed and the space needs to be treated as a fresh skeleton again.
   */
  upsertFromRemote(remote: RemoteSpace, workspaceName?: string | null): Space;
  markSynced(id: number): void;
  softDeleteByCloudId(cloudSpaceId: string): void;
}
