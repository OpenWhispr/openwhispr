import {
  defaultActiveWorkspaceId,
  foldersInPrivateWorkspace,
  groupPrivateFoldersByWorkspace,
  pickPrivateDefaultFolder,
  pickPrivateMeetingsFolder,
  privateWorkspaceOf,
  resolveActivePrivateWorkspaceId,
  resolveDefaultPrivateWorkspaceId,
  type PrivateWorkspace,
} from '../privateWorkspaces';
import type { Folder } from '@/data';

const workspace = (overrides: Partial<PrivateWorkspace> & { id: string }): PrivateWorkspace => ({
  name: overrides.id,
  ...overrides,
});

const folder = (overrides: Partial<Folder> & { id: number }): Folder =>
  ({
    name: 'Folder',
    isDefault: 0,
    sortOrder: 0,
    clientFolderId: null,
    privateWorkspaceId: null,
    remoteId: null,
    deletedAt: null,
    pendingSync: 0,
    spaceId: 1,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }) as Folder;

const OWN = workspace({ id: 'own', is_default: true });
const TEAM = workspace({ id: 'team' });
const ENTERPRISE = workspace({ id: 'enterprise', plan: 'enterprise', status: 'active' });

describe('resolveDefaultPrivateWorkspaceId', () => {
  it('prefers the default the server reported', () => {
    expect(resolveDefaultPrivateWorkspaceId([OWN, TEAM], 'server-default')).toBe('server-default');
  });

  it('falls back to the listed own default, then an entitled Enterprise workspace', () => {
    expect(resolveDefaultPrivateWorkspaceId([TEAM, OWN], null)).toBe('own');
    expect(resolveDefaultPrivateWorkspaceId([TEAM, ENTERPRISE], null)).toBe('enterprise');
    expect(
      resolveDefaultPrivateWorkspaceId(
        [TEAM, workspace({ id: 'lapsed', plan: 'enterprise', status: 'canceled' })],
        null,
      ),
    ).toBeNull();
  });
});

describe('defaultActiveWorkspaceId', () => {
  it('picks an entitled Enterprise workspace, else the own default, else the first', () => {
    expect(defaultActiveWorkspaceId([OWN, ENTERPRISE])).toBe('enterprise');
    expect(defaultActiveWorkspaceId([TEAM, OWN])).toBe('own');
    expect(defaultActiveWorkspaceId([TEAM])).toBe('team');
    expect(defaultActiveWorkspaceId([])).toBeNull();
  });
});

describe('resolveActivePrivateWorkspaceId', () => {
  it('keeps the saved choice while it is still listed', () => {
    expect(
      resolveActivePrivateWorkspaceId({
        workspaces: [OWN, TEAM],
        savedId: 'team',
        defaultId: 'own',
      }),
    ).toBe('team');
  });

  it('drops a saved choice that is no longer listed', () => {
    expect(
      resolveActivePrivateWorkspaceId({ workspaces: [OWN], savedId: 'left', defaultId: 'own' }),
    ).toBe('own');
  });

  it('uses the default when no workspace list has been read', () => {
    expect(
      resolveActivePrivateWorkspaceId({ workspaces: [], savedId: 'team', defaultId: 'own' }),
    ).toBe('own');
    expect(
      resolveActivePrivateWorkspaceId({ workspaces: [], savedId: null, defaultId: null }),
    ).toBeNull();
  });
});

describe('Private folder scoping', () => {
  // Each workspace's Private seeds its own Personal and Meetings, so the names tie.
  const defaultPersonal = folder({
    id: 1,
    name: 'Personal',
    isDefault: 1,
    privateWorkspaceId: null,
  });
  const defaultMeetings = folder({ id: 2, name: 'Meetings', isDefault: 1, sortOrder: 1 });
  const teamPersonal = folder({
    id: 3,
    name: 'Personal',
    isDefault: 1,
    privateWorkspaceId: 'team',
  });
  const teamMeetings = folder({
    id: 4,
    name: 'Meetings',
    isDefault: 1,
    sortOrder: 1,
    privateWorkspaceId: 'team',
  });
  const explicitDefault = folder({ id: 5, name: 'Ideas', privateWorkspaceId: 'own' });
  // getPrivateFolders sorts by sort_order, name: the two workspaces interleave.
  const all = [teamPersonal, defaultPersonal, explicitDefault, teamMeetings, defaultMeetings];

  it('reads an unplaced folder as the default workspace’s', () => {
    expect(privateWorkspaceOf(defaultPersonal, 'own')).toBe('own');
    expect(privateWorkspaceOf(teamPersonal, 'own')).toBe('team');
    expect(privateWorkspaceOf(defaultPersonal, null)).toBeNull();
  });

  it('keeps only the asked workspace’s folders', () => {
    expect(foldersInPrivateWorkspace(all, 'own', 'own').map((f) => f.id)).toEqual([1, 5, 2]);
    expect(foldersInPrivateWorkspace(all, 'team', 'own').map((f) => f.id)).toEqual([3, 4]);
    // No workspace known: only the unplaced folders.
    expect(foldersInPrivateWorkspace(all, null, null).map((f) => f.id)).toEqual([1, 2]);
  });

  it('never picks another workspace’s Personal or Meetings', () => {
    const inDefault = foldersInPrivateWorkspace(all, 'own', 'own');
    const inTeam = foldersInPrivateWorkspace(all, 'team', 'own');
    expect(pickPrivateDefaultFolder(inDefault)?.id).toBe(1);
    expect(pickPrivateMeetingsFolder(inDefault)?.id).toBe(2);
    expect(pickPrivateDefaultFolder(inTeam)?.id).toBe(3);
    expect(pickPrivateMeetingsFolder(inTeam)?.id).toBe(4);
  });

  it('prefers Personal over another default folder and has nothing to pick when empty', () => {
    expect(pickPrivateDefaultFolder([defaultMeetings, defaultPersonal])?.id).toBe(1);
    expect(pickPrivateDefaultFolder([explicitDefault])?.id).toBe(5);
    expect(pickPrivateDefaultFolder([])).toBeNull();
    expect(pickPrivateMeetingsFolder([explicitDefault])).toBeNull();
  });

  it('groups folders under their workspace, the asked one first', () => {
    const groups = groupPrivateFoldersByWorkspace(all, {
      workspaces: [OWN, TEAM],
      firstId: 'team',
      defaultId: 'own',
    });
    expect(groups.map((g) => [g.workspaceId, g.name, g.folders.map((f) => f.id)])).toEqual([
      ['team', 'team', [3, 4]],
      ['own', 'own', [1, 5, 2]],
    ]);
  });

  it('shows a lost workspace’s folders in the default Private without picking them', () => {
    const orphanPersonal = folder({
      id: 9,
      name: 'Personal',
      isDefault: 1,
      privateWorkspaceId: 'gone',
    });
    const listed = ['own', 'team'];
    const shown = foldersInPrivateWorkspace([orphanPersonal, ...all], 'own', 'own', listed);
    expect(shown.map((f) => f.id)).toEqual([9, 1, 5, 2]);
    expect(foldersInPrivateWorkspace([orphanPersonal, ...all], 'team', 'own', listed)).toEqual([
      teamPersonal,
      teamMeetings,
    ]);
    // Picks read only the workspace's own folders.
    const strict = foldersInPrivateWorkspace([orphanPersonal, ...all], 'own', 'own');
    expect(pickPrivateDefaultFolder(strict)?.id).toBe(1);
  });

  it('leaves out folders of a workspace the account no longer lists', () => {
    const orphan = folder({ id: 9, name: 'Old', privateWorkspaceId: 'gone' });
    const groups = groupPrivateFoldersByWorkspace([...all, orphan], {
      workspaces: [OWN, TEAM],
      firstId: 'own',
      defaultId: 'own',
    });
    expect(groups.flatMap((g) => g.folders.map((f) => f.id))).not.toContain(9);
  });
});
