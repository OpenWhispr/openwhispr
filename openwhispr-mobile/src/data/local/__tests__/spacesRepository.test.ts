import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import type { RemoteSpace } from '@/data/spacesTypes';
import { LocalSpacesRepository } from '../spacesRepository';
import { createMemoryRepository } from './testDb';

type SpacesRepoCtorArg = ConstructorParameters<typeof LocalSpacesRepository>[0];

const remoteSpace = (overrides: Partial<RemoteSpace> = {}): RemoteSpace => ({
  id: 'remote-space-1',
  workspace_id: 'workspace-1',
  name: 'Engineering',
  emoji: '🛠️',
  my_role: 'member',
  member_count: 3,
  teams: ['team-a'],
  ...overrides,
});

const createSpacesRepo = () => {
  const { db } = createMemoryRepository();
  return { db, repo: new LocalSpacesRepository(db as unknown as SpacesRepoCtorArg) };
};

describe('LocalSpacesRepository', () => {
  it('getPrivateSpace returns the migration-seeded private space', () => {
    const { repo } = createSpacesRepo();

    const space = repo.getPrivateSpace();

    expect(space).toMatchObject({ kind: 'private', name: 'Personal', syncStatus: 'synced' });
    expect(space.clientSpaceId).toEqual(expect.any(String));
  });

  it('getPrivateSpace throws when no private space has been seeded', () => {
    // A bare spaces table, deliberately without the migration's seed row —
    // exercises the "should never happen" guard directly.
    const rawDb = new Database(':memory:');
    rawDb.exec(`
      CREATE TABLE spaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_space_id TEXT NOT NULL,
        cloud_space_id TEXT,
        workspace_id TEXT,
        workspace_name TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        my_role TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        teams TEXT,
        sync_status TEXT NOT NULL DEFAULT 'synced',
        deleted_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    const db = drizzle(rawDb, { schema });
    const repo = new LocalSpacesRepository(db as unknown as SpacesRepoCtorArg);

    expect(() => repo.getPrivateSpace()).toThrow(/Private space not found/);
  });

  it('upsertFromRemote inserts a new team space as pending', () => {
    const { repo } = createSpacesRepo();

    const created = repo.upsertFromRemote(remoteSpace());

    expect(created).toMatchObject({
      cloudSpaceId: 'remote-space-1',
      workspaceId: 'workspace-1',
      kind: 'team',
      name: 'Engineering',
      emoji: '🛠️',
      myRole: 'member',
      memberCount: 3,
      syncStatus: 'pending',
    });
    expect(created.teams).toBe(JSON.stringify(['team-a']));
    expect(created.clientSpaceId).toEqual(expect.any(String));
  });

  it('upsertFromRemote updates an existing space matched by cloud_space_id', () => {
    const { repo } = createSpacesRepo();
    const created = repo.upsertFromRemote(remoteSpace());
    repo.markSynced(created.id);

    const updated = repo.upsertFromRemote(
      remoteSpace({
        name: 'Engineering Renamed',
        member_count: 5,
        my_role: 'admin',
        emoji: '🚀',
        workspace_id: 'workspace-2',
      }),
    );

    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({
      name: 'Engineering Renamed',
      memberCount: 5,
      myRole: 'admin',
      emoji: '🚀',
      workspaceId: 'workspace-2',
      deletedAt: null,
      // A routine metadata update (never soft-deleted) must leave sync_status
      // alone — the spaces sync pass calls upsertFromRemote for every space
      // on every run, so resetting it here would make it permanently
      // 'pending'. See the resurrection test below for the case that DOES
      // reset it.
      syncStatus: 'synced',
    });
    // Private (seeded) + this one team space.
    expect(repo.listSpaces()).toHaveLength(2);
  });

  it('upsertFromRemote resurrects a soft-deleted space instead of leaving it invisible forever', () => {
    const { repo } = createSpacesRepo();
    const created = repo.upsertFromRemote(remoteSpace());
    repo.markSynced(created.id);
    repo.softDeleteByCloudId('remote-space-1');
    expect(repo.listSpaces().map((s) => s.id)).not.toContain(created.id);

    const resurrected = repo.upsertFromRemote(remoteSpace({ name: 'Engineering' }));

    expect(resurrected.id).toBe(created.id);
    expect(resurrected.deletedAt).toBeNull();
    expect(resurrected.syncStatus).toBe('pending');
    expect(repo.listSpaces().map((s) => s.id)).toContain(created.id);
  });

  it('getByCloudId returns null when nothing matches', () => {
    const { repo } = createSpacesRepo();

    expect(repo.getByCloudId('does-not-exist')).toBeNull();
  });

  it('markSynced flips a pending space to synced', () => {
    const { repo } = createSpacesRepo();
    const created = repo.upsertFromRemote(remoteSpace());
    expect(created.syncStatus).toBe('pending');

    repo.markSynced(created.id);

    expect(repo.getByCloudId('remote-space-1')?.syncStatus).toBe('synced');
  });

  it('softDeleteByCloudId marks the space deleted and listSpaces excludes it', () => {
    const { repo } = createSpacesRepo();
    const created = repo.upsertFromRemote(remoteSpace());

    repo.softDeleteByCloudId('remote-space-1');

    const fetched = repo.getByCloudId('remote-space-1');
    expect(fetched?.deletedAt).toEqual(expect.any(String));
    expect(repo.listSpaces().map((s) => s.id)).not.toContain(created.id);
    // The private space (never deleted) is still visible.
    expect(repo.listSpaces().some((s) => s.kind === 'private')).toBe(true);
  });
});
