jest.mock('@/data', () => ({
  spacesRepository: {
    listSpaces: jest.fn(),
    upsertFromRemote: jest.fn(),
    softDeleteByCloudId: jest.fn(),
  },
}));
jest.mock('@/data/remote/spacesApi', () => ({
  fetchMySpaces: jest.fn(),
}));
jest.mock('@/data/remote/workspacesApi', () => ({
  fetchMyWorkspaces: jest.fn(),
}));
jest.mock('@/lib/apiClient', () => {
  class MockApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { ApiError: MockApiError };
});
jest.mock('../teamSpacesCapability', () => ({
  setTeamSpacesCapability: jest.fn(),
}));

import { syncSpaces } from '../syncSpaces';
import { spacesRepository } from '@/data';
import { fetchMySpaces } from '@/data/remote/spacesApi';
import { fetchMyWorkspaces } from '@/data/remote/workspacesApi';
import { ApiError } from '@/lib/apiClient';
import { setTeamSpacesCapability } from '../teamSpacesCapability';
import type { Space } from '@/data/spacesTypes';

const mockRepo = spacesRepository as jest.Mocked<typeof spacesRepository>;
const mockFetchMySpaces = fetchMySpaces as jest.MockedFunction<typeof fetchMySpaces>;
const mockFetchMyWorkspaces = fetchMyWorkspaces as jest.MockedFunction<typeof fetchMyWorkspaces>;
const mockSetCapability = setTeamSpacesCapability as jest.MockedFunction<
  typeof setTeamSpacesCapability
>;

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 1,
    clientSpaceId: 'client-1',
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
    ...overrides,
  } as Space;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.listSpaces.mockReturnValue([]);
  mockFetchMyWorkspaces.mockResolvedValue({ data: [] });
});

describe('syncSpaces', () => {
  it('404 sets capability false, returns an empty result, and never throws or upserts', async () => {
    mockFetchMySpaces.mockRejectedValue(new ApiError('not found', 404));

    const result = await syncSpaces();

    expect(result).toEqual({ capable: false, activeSpaces: [] });
    expect(mockSetCapability).toHaveBeenCalledWith(false);
    expect(mockRepo.upsertFromRemote).not.toHaveBeenCalled();
    expect(mockRepo.softDeleteByCloudId).not.toHaveBeenCalled();
  });

  it.each([405, 501])('%d gets the same endpoint-unavailable treatment as 404', async (status) => {
    mockFetchMySpaces.mockRejectedValue(new ApiError('nope', status));

    const result = await syncSpaces();

    expect(result).toEqual({ capable: false, activeSpaces: [] });
    expect(mockSetCapability).toHaveBeenCalledWith(false);
    expect(mockRepo.upsertFromRemote).not.toHaveBeenCalled();
  });

  it('success sets capability true, upserts every remote space, and soft-deletes team spaces missing from the response', async () => {
    const privateSpace = makeSpace({ id: 1, kind: 'private', cloudSpaceId: null });
    const staleTeamSpace = makeSpace({
      id: 2,
      kind: 'team',
      cloudSpaceId: 'stale-1',
      name: 'Stale',
    });
    const keptTeamSpace = makeSpace({
      id: 3,
      kind: 'team',
      cloudSpaceId: 'kept-1',
      name: 'Kept',
    });
    mockRepo.listSpaces.mockReturnValue([privateSpace, staleTeamSpace, keptTeamSpace]);
    const remoteSpaces = [{ id: 'kept-1', workspace_id: 'w1', name: 'Kept', my_role: 'member' }];
    mockFetchMySpaces.mockResolvedValue({ data: remoteSpaces });
    mockFetchMyWorkspaces.mockResolvedValue({ data: [{ id: 'w1', name: 'Acme' }] });

    const result = await syncSpaces();

    expect(mockSetCapability).toHaveBeenCalledWith(true);
    expect(mockRepo.upsertFromRemote).toHaveBeenCalledTimes(1);
    expect(mockRepo.upsertFromRemote).toHaveBeenCalledWith(remoteSpaces[0], 'Acme');
    expect(mockRepo.softDeleteByCloudId).toHaveBeenCalledTimes(1);
    expect(mockRepo.softDeleteByCloudId).toHaveBeenCalledWith('stale-1');
    expect(result).toEqual({ capable: true, activeSpaces: [privateSpace, keptTeamSpace] });
  });

  it('never soft-deletes the private space, even when the response is empty', async () => {
    const privateSpace = makeSpace({ id: 1, kind: 'private', cloudSpaceId: null });
    mockRepo.listSpaces.mockReturnValue([privateSpace]);
    mockFetchMySpaces.mockResolvedValue({ data: [] });

    const result = await syncSpaces();

    expect(mockRepo.softDeleteByCloudId).not.toHaveBeenCalled();
    expect(result.activeSpaces).toEqual([privateSpace]);
  });

  it('rethrows a non-404/405/501 ApiError and leaves capability untouched', async () => {
    mockFetchMySpaces.mockRejectedValue(new ApiError('server error', 500));

    await expect(syncSpaces()).rejects.toThrow('server error');
    expect(mockSetCapability).not.toHaveBeenCalled();
    expect(mockRepo.upsertFromRemote).not.toHaveBeenCalled();
    expect(mockRepo.softDeleteByCloudId).not.toHaveBeenCalled();
  });

  it('rethrows a non-ApiError failure (e.g. network error) too', async () => {
    mockFetchMySpaces.mockRejectedValue(new Error('network down'));

    await expect(syncSpaces()).rejects.toThrow('network down');
    expect(mockSetCapability).not.toHaveBeenCalled();
  });
});
