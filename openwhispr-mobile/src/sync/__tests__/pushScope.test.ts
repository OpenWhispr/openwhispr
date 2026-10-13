jest.mock('@/data', () => ({
  notesRepository: { getSyncState: jest.fn() },
  spacesRepository: { listSpaces: jest.fn() },
}));

import { createPushScopeResolver } from '../pushScope';
import { notesRepository, spacesRepository } from '@/data';
import type { Space } from '@/data';

const mockGetSyncState = notesRepository.getSyncState as jest.Mock;
const mockListSpaces = spacesRepository.listSpaces as jest.Mock;

const space = (over: Partial<Space>): Space =>
  ({
    id: 1,
    clientSpaceId: 'client-space-1',
    cloudSpaceId: null,
    workspaceId: null,
    kind: 'private',
    name: 'Personal',
    emoji: null,
    sortOrder: 0,
    myRole: null,
    memberCount: 0,
    teams: null,
    syncStatus: 'synced',
    deletedAt: null,
    createdAt: null,
    updatedAt: null,
    ...over,
  }) as Space;

const PRIVATE = space({ id: 1, kind: 'private' });
const TEAM = space({
  id: 2,
  kind: 'team',
  name: 'Design',
  cloudSpaceId: 'cloud-space-2',
  workspaceId: 'workspace-9',
});
const TEAM_SKELETON = space({ id: 3, kind: 'team', name: 'Pending', cloudSpaceId: null });

describe('createPushScopeResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListSpaces.mockReturnValue([PRIVATE, TEAM, TEAM_SKELETON]);
  });

  it('omits both scope fields entirely when the capability has never been probed', () => {
    mockGetSyncState.mockReturnValue(null);

    const resolve = createPushScopeResolver();

    expect(resolve(PRIVATE.id)).toEqual({});
    expect(resolve(TEAM.id)).toEqual({});
    expect(resolve(null)).toEqual({});
    // An old server must never even see the keys, so the spaces table is not
    // consulted at all in this mode.
    expect(mockListSpaces).not.toHaveBeenCalled();
  });

  it('omits both scope fields when the backend is known not to support spaces', () => {
    mockGetSyncState.mockReturnValue('false');

    const resolve = createPushScopeResolver();

    expect(resolve(TEAM.id)).toEqual({});
    expect(mockListSpaces).not.toHaveBeenCalled();
  });

  describe('with the team-spaces capability confirmed', () => {
    beforeEach(() => {
      mockGetSyncState.mockReturnValue('true');
    });

    it('sends the space identity for a row in a team space with a cloud id', () => {
      expect(createPushScopeResolver()(TEAM.id)).toEqual({
        workspace_id: 'workspace-9',
        space_id: 'cloud-space-2',
      });
    });

    it('returns null (skip this row) for a team space whose cloud id has not arrived yet', () => {
      expect(createPushScopeResolver()(TEAM_SKELETON.id)).toBeNull();
    });

    it('sends explicit nulls for the private space — that is how a move back to personal travels', () => {
      expect(createPushScopeResolver()(PRIVATE.id)).toEqual({
        workspace_id: null,
        space_id: null,
      });
    });

    it('sends explicit nulls for a row that carries no space at all', () => {
      expect(createPushScopeResolver()(null)).toEqual({ workspace_id: null, space_id: null });
    });

    it('returns null (skip this row) for a space id that no longer resolves', () => {
      // Reachable inside a single run: syncSpaces soft-deletes a revoked space
      // before the push passes, so its rows point at a space listSpaces no
      // longer returns. Claiming "move this out of its space" for content we
      // just lost access to would be wrong — wait instead.
      expect(createPushScopeResolver()(404)).toBeNull();
    });

    it('reads the spaces table once per pass, not once per row', () => {
      const resolve = createPushScopeResolver();
      resolve(TEAM.id);
      resolve(PRIVATE.id);
      resolve(TEAM.id);

      expect(mockListSpaces).toHaveBeenCalledTimes(1);
    });
  });
});
