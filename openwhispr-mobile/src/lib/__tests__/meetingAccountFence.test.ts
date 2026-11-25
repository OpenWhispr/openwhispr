let mockUser: { id: string } | null = null;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));

import { captureMeetingAccount } from '@/lib/notes/meetingAccountFence';

beforeEach(() => {
  mockUser = null;
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
});
