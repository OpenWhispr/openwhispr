jest.mock('@/data', () => ({
  notesRepository: { getSyncState: jest.fn(), setSyncState: jest.fn(), clearSyncState: jest.fn() },
}));

import { notesRepository } from '@/data';
import { hasRealAccountHistory, isAccountLink, recordAccountLink } from '../syncIdentity';

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

describe('isAccountLink', () => {
  it('is a link while the previous id is the anonymous user the rows belong to', () => {
    seed({ 'sync.user_id': 'anon-a', 'sync.anonymous_user_id': 'anon-a' });
    expect(isAccountLink('anon-a', 'real-a')).toBe(true);
  });

  it('stays a link after the sync run that linked consumed the token', () => {
    seed({ 'sync.user_id': 'anon-b', 'sync.anonymous_user_id': 'anon-b' });
    recordAccountLink('anon-b', 'real-b');
    seed({ 'sync.user_id': 'real-b' });
    expect(isAccountLink('anon-b', 'real-b')).toBe(true);
  });

  it('is not a link between two real accounts', () => {
    seed({ 'sync.user_id': 'real-c' });
    expect(isAccountLink('real-c', 'real-d')).toBe(false);
  });

  it('a recorded link names one account, not any later one', () => {
    seed({});
    recordAccountLink('anon-e', 'real-e');
    expect(isAccountLink('anon-e', 'real-f')).toBe(false);
    expect(isAccountLink('real-e', 'real-f')).toBe(false);
  });
});
