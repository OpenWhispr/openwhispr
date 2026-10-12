jest.mock('@/data', () => ({
  notesRepository: { getSyncState: jest.fn(), setSyncState: jest.fn(), clearSyncState: jest.fn() },
}));

import { notesRepository } from '@/data';
import { hasRealAccountHistory } from '../syncIdentity';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;

function seed(state: Record<string, string>): void {
  mockRepo.getSyncState.mockImplementation((key: string) => state[key] ?? null);
}

describe('hasRealAccountHistory', () => {
  it('is false on a device that never synced', () => {
    seed({});
    expect(hasRealAccountHistory()).toBe(false);
  });

  it('is false while the last synced identity is the anonymous session itself', () => {
    seed({ 'sync.user_id': 'anon-user', 'sync.anonymous_user_id': 'anon-user' });
    expect(hasRealAccountHistory()).toBe(false);
  });

  it('is true once a real account has synced on the device', () => {
    seed({ 'sync.user_id': 'real-user' });
    expect(hasRealAccountHistory()).toBe(true);
  });
});
