jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
  },
}));

import {
  getPrivateWorkspaces,
  getTeamSpacesCapability,
  readPrivateWorkspaceContext,
  setActivePrivateWorkspaceChoice,
  setDefaultPrivateWorkspaceId,
  setPrivateWorkspacePlacement,
  setPrivateWorkspaces,
  setTeamSpacesCapability,
} from '../teamSpacesCapability';
import { notesRepository } from '@/data';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('teamSpacesCapability', () => {
  it('returns null (unprobed) when no sync_state row exists yet', () => {
    mockRepo.getSyncState.mockReturnValue(null);

    expect(getTeamSpacesCapability()).toBeNull();
  });

  it('returns true when persisted as "true"', () => {
    mockRepo.getSyncState.mockReturnValue('true');

    expect(getTeamSpacesCapability()).toBe(true);
  });

  it('returns false when persisted as "false"', () => {
    mockRepo.getSyncState.mockReturnValue('false');

    expect(getTeamSpacesCapability()).toBe(false);
  });

  it('reads under the fixed "team_spaces_capability" key', () => {
    mockRepo.getSyncState.mockReturnValue(null);

    getTeamSpacesCapability();

    expect(mockRepo.getSyncState).toHaveBeenCalledWith('team_spaces_capability');
  });

  it('setTeamSpacesCapability(true) persists "true" under the fixed key', () => {
    setTeamSpacesCapability(true);

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('team_spaces_capability', 'true');
  });

  it('setTeamSpacesCapability(false) persists "false" under the fixed key', () => {
    setTeamSpacesCapability(false);

    expect(mockRepo.setSyncState).toHaveBeenCalledWith('team_spaces_capability', 'false');
  });
});

describe('readPrivateWorkspaceContext', () => {
  const state = new Map<string, string>();
  beforeEach(() => {
    state.clear();
    mockRepo.getSyncState.mockImplementation((key: string) => state.get(key) ?? null);
    mockRepo.setSyncState.mockImplementation((key: string, value: string) => {
      state.set(key, value);
    });
  });

  const workspaces = [
    { id: 'team', name: 'Acme' },
    { id: 'own', name: 'Mine', is_default: true },
  ];

  it('shows only the default Private until the API keeps one per workspace', () => {
    setPrivateWorkspaces(workspaces);
    setDefaultPrivateWorkspaceId('own');
    setActivePrivateWorkspaceChoice('team');
    expect(readPrivateWorkspaceContext()).toEqual({
      placementSupported: false,
      workspaces: [],
      defaultId: 'own',
      activeId: 'own',
    });
  });

  it('follows the saved choice, else picks the default', () => {
    setPrivateWorkspacePlacement(true);
    setPrivateWorkspaces(workspaces);
    expect(readPrivateWorkspaceContext()).toMatchObject({
      placementSupported: true,
      defaultId: 'own',
      activeId: 'own',
    });
    setActivePrivateWorkspaceChoice('team');
    expect(readPrivateWorkspaceContext().activeId).toBe('team');
    setPrivateWorkspaces([workspaces[1]]);
    expect(readPrivateWorkspaceContext().activeId).toBe('own');
  });

  it('reads a damaged workspace list as none', () => {
    setPrivateWorkspacePlacement(true);
    state.set('private_workspaces', '{not json');
    expect(getPrivateWorkspaces()).toEqual([]);
    state.set('private_workspaces', JSON.stringify([{ id: 'ok', name: 'Ok' }, { name: 'no id' }]));
    expect(getPrivateWorkspaces()).toEqual([{ id: 'ok', name: 'Ok' }]);
  });
});
