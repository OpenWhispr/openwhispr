jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
  },
}));

import { getTeamSpacesCapability, setTeamSpacesCapability } from '../teamSpacesCapability';
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
