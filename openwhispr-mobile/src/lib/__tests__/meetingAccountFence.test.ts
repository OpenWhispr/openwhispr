let mockUser: { id: string } | null = null;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));

const mockLinks = new Set<string>();
jest.mock('@/sync/syncIdentity', () => ({
  isAccountLink: (from: string, to: string) => mockLinks.has(`${from}>${to}`),
}));

import { captureMeetingAccount, meetingAccountFenceFor } from '@/lib/notes/meetingAccountFence';

beforeEach(() => {
  mockUser = null;
  mockLinks.clear();
});

describe('captureMeetingAccount', () => {
  it('stays current while the same account is signed in', () => {
    mockUser = { id: 'a' };
    const fence = captureMeetingAccount();
    expect(fence.accountId).toBe('a');
    expect(fence.isCurrent()).toBe(true);
  });

  it('is no longer current when another account signs in', () => {
    mockUser = { id: 'a' };
    const fence = captureMeetingAccount();
    mockUser = { id: 'b' };
    expect(fence.isCurrent()).toBe(false);
  });

  it('is no longer current after sign-out', () => {
    mockUser = { id: 'a' };
    const fence = captureMeetingAccount();
    mockUser = null;
    expect(fence.isCurrent()).toBe(false);
  });

  it('a signed-out meeting is fenced off from a sign-in mid-processing', () => {
    const fence = captureMeetingAccount();
    expect(fence.accountId).toBeNull();
    expect(fence.isCurrent()).toBe(true);
    mockUser = { id: 'a' };
    expect(fence.isCurrent()).toBe(false);
  });

  it('a link from the anonymous id still counts as current', () => {
    mockUser = { id: 'anon' };
    const fence = captureMeetingAccount();
    mockLinks.add('anon>real');
    mockUser = { id: 'real' };
    expect(fence.isCurrent()).toBe(true);
    // The fence now belongs to the linked account: a later switch away from it still counts.
    expect(fence.accountId).toBe('real');
    mockUser = { id: 'other' };
    expect(fence.isCurrent()).toBe(false);
  });
});

describe('meetingAccountFenceFor', () => {
  it('fences a saved owner against the account signed in now', () => {
    mockUser = { id: 'a' };
    expect(meetingAccountFenceFor('a').isCurrent()).toBe(true);
    expect(meetingAccountFenceFor('b').isCurrent()).toBe(false);
    expect(meetingAccountFenceFor(null).isCurrent()).toBe(false);
    mockUser = null;
    expect(meetingAccountFenceFor(null).isCurrent()).toBe(true);
  });

  it('follows a saved anonymous owner to the account it became', () => {
    mockLinks.add('anon>real');
    mockUser = { id: 'real' };
    const fence = meetingAccountFenceFor('anon');
    expect(fence.isCurrent()).toBe(true);
    expect(fence.accountId).toBe('real');
  });
});
