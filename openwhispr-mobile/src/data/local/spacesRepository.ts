import { asc, eq, isNull, sql } from 'drizzle-orm';
import { spaces } from '@/db/schema';
import { randomUUID } from '@/lib/uuid';
import type { RemoteSpace, Space, SpaceMyRole, SpacesRepository } from '../spacesTypes';

type SpacesDb = typeof import('@/db').db;

const getDefaultDb = (): SpacesDb => {
  const { db } = require('@/db') as typeof import('@/db');
  return db;
};

const toMyRole = (myRole: string): SpaceMyRole | null =>
  myRole === 'admin' || myRole === 'member' ? myRole : null;

export class LocalSpacesRepository implements SpacesRepository {
  private readonly database: SpacesDb;

  constructor(database?: SpacesDb) {
    this.database = database ?? getDefaultDb();
  }

  getPrivateSpace(): Space {
    const row = this.database.select().from(spaces).where(eq(spaces.kind, 'private')).get();
    if (!row) {
      throw new Error('Private space not found — the migration should have seeded it');
    }
    return row;
  }

  listSpaces(): Space[] {
    return this.database
      .select()
      .from(spaces)
      .where(isNull(spaces.deletedAt))
      .orderBy(asc(spaces.sortOrder), asc(spaces.name))
      .all();
  }

  getByCloudId(cloudSpaceId: string): Space | null {
    return (
      this.database.select().from(spaces).where(eq(spaces.cloudSpaceId, cloudSpaceId)).get() ?? null
    );
  }

  upsertFromRemote(remote: RemoteSpace, workspaceName?: string | null): Space {
    const existing = this.getByCloudId(remote.id);
    const values = {
      name: remote.name,
      emoji: remote.emoji ?? null,
      myRole: toMyRole(remote.my_role),
      memberCount: remote.member_count ?? 0,
      teams: remote.teams ? JSON.stringify(remote.teams) : null,
      workspaceId: remote.workspace_id,
      // Omitted when the caller couldn't resolve a name, so a transient
      // /api/workspaces failure never wipes a name already stored.
      ...(workspaceName != null ? { workspaceName } : {}),
    };

    if (!existing) {
      return this.database
        .insert(spaces)
        .values({
          clientSpaceId: randomUUID(),
          cloudSpaceId: remote.id,
          kind: 'team',
          syncStatus: 'pending',
          ...values,
        })
        .returning()
        .get();
    }

    this.database
      .update(spaces)
      .set({
        ...values,
        // Always clear the tombstone — even a routine metadata update should
        // never leave a space stuck soft-deleted. But only reset sync_status
        // to 'pending' when this row was ACTUALLY tombstoned (a real
        // resurrection): softDeleteByCloudId's caller purged whatever content
        // backfill had completed, so that case needs a fresh skeleton. A
        // plain metadata update (rename, role change) on a row that was never
        // deleted must leave sync_status untouched — the spaces sync pass
        // calls upsertFromRemote on every space on every run, so resetting
        // unconditionally would make sync_status permanently 'pending'.
        deletedAt: null,
        ...(existing.deletedAt ? { syncStatus: 'pending' as const } : {}),
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(spaces.id, existing.id))
      .run();
    return this.getByCloudId(remote.id)!;
  }

  markSynced(id: number): void {
    this.database
      .update(spaces)
      .set({ syncStatus: 'synced', updatedAt: sql`datetime('now')` })
      .where(eq(spaces.id, id))
      .run();
  }

  softDeleteByCloudId(cloudSpaceId: string): void {
    this.database
      .update(spaces)
      .set({ deletedAt: sql`datetime('now')`, updatedAt: sql`datetime('now')` })
      .where(eq(spaces.cloudSpaceId, cloudSpaceId))
      .run();
  }
}
