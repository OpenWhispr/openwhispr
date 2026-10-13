jest.mock('@/data', () => ({
  notesRepository: { clearSyncState: jest.fn() },
}));

import { notesRepository } from '@/data';
import {
  resetTeamCursors,
  TEAM_FOLDERS_CURSOR_KEY,
  TEAM_NOTES_CURSOR_ID_KEY,
  TEAM_NOTES_CURSOR_KEY,
} from '../teamCursors';

const mockClearSyncState = notesRepository.clearSyncState as jest.Mock;

describe('resetTeamCursors', () => {
  it('removes both team note cursors and the team folder cursor', () => {
    jest.clearAllMocks();

    resetTeamCursors();

    expect(mockClearSyncState).toHaveBeenCalledTimes(3);
    expect(mockClearSyncState).toHaveBeenCalledWith('notes.team.last_sync_at');
    expect(mockClearSyncState).toHaveBeenCalledWith('notes.team.last_sync_id');
    expect(mockClearSyncState).toHaveBeenCalledWith('folders.team.last_sync_at');
  });

  it('exports the same key strings the team pull passes read', () => {
    // The pull files import these constants, so a rename here can never leave
    // the reset clearing keys nothing reads.
    expect(TEAM_NOTES_CURSOR_KEY).toBe('notes.team.last_sync_at');
    expect(TEAM_NOTES_CURSOR_ID_KEY).toBe('notes.team.last_sync_id');
    expect(TEAM_FOLDERS_CURSOR_KEY).toBe('folders.team.last_sync_at');
  });
});
