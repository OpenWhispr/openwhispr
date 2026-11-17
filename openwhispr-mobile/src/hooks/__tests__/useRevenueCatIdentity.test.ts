import { renderHook } from '@testing-library/react-native';
import { useRevenueCatIdentity } from '../useRevenueCatIdentity';

type MockAuth = { isInitialized: boolean; user: { id: string } | null; isGuest: boolean };
let mockAuth: MockAuth;
let mockBillingUserId: string | null;
const mockIdentify = jest.fn();
const mockReset = jest.fn();
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuth) => unknown) => selector(mockAuth),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: unknown) => unknown) =>
    selector({ usage: { billingUserId: mockBillingUserId } }),
}));
jest.mock('@/lib/revenuecat', () => ({
  configureRevenueCat: jest.fn(),
  identifyRevenueCatUser: (...args: unknown[]) => mockIdentify(...args),
  resetRevenueCatUser: () => mockReset(),
}));

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// A new user object, as a session refresh hands the effect.
function refreshSession(): void {
  mockAuth = { ...mockAuth, user: { id: 'account' } };
}

beforeEach(() => {
  mockAuth = { isInitialized: true, user: { id: 'account' }, isGuest: false };
  mockBillingUserId = 'billing-a';
  mockIdentify.mockReset();
  mockReset.mockReset();
});

it('queues logout even if the previous identify has not resolved', () => {
  mockIdentify.mockReturnValue(new Promise(() => {}));
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  expect(mockIdentify).toHaveBeenCalledWith('billing-a');
  mockAuth = { ...mockAuth, user: null };
  rerender({});
  expect(mockReset).toHaveBeenCalledTimes(1);
});

it('still signs out after identify failed, since the native login may land late', async () => {
  mockIdentify.mockResolvedValue(false);
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  await flush();
  mockAuth = { ...mockAuth, user: null };
  rerender({});
  expect(mockReset).toHaveBeenCalledTimes(1);
});

it('retries a failed identify on the next auth update, then stops once identified', async () => {
  const first = deferred();
  mockIdentify.mockReturnValueOnce(first.promise).mockResolvedValue(true);
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  first.resolve(false);
  await flush();
  refreshSession();
  rerender({});
  expect(mockIdentify).toHaveBeenCalledTimes(2);
  await flush();
  refreshSession();
  rerender({});
  expect(mockIdentify).toHaveBeenCalledTimes(2);
});

it('ignores a stale success from before a sign-out', async () => {
  const stale = deferred();
  mockIdentify.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(false);
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  mockAuth = { ...mockAuth, user: null };
  rerender({});
  mockAuth = { ...mockAuth, user: { id: 'account' } };
  rerender({});
  expect(mockIdentify).toHaveBeenCalledTimes(2);
  stale.resolve(true);
  await flush();
  mockIdentify.mockResolvedValue(true);
  refreshSession();
  rerender({});
  expect(mockIdentify).toHaveBeenCalledTimes(3);
});

it('identifies the first account again after a failed switch away from it', async () => {
  mockIdentify.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  await flush();
  mockBillingUserId = 'billing-b';
  rerender({});
  await flush();
  mockBillingUserId = 'billing-a';
  rerender({});
  expect(mockIdentify.mock.calls.map(([id]) => id)).toEqual([
    'billing-a',
    'billing-b',
    'billing-a',
  ]);
});
