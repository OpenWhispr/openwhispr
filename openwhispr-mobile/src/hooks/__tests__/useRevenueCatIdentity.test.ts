import { renderHook, waitFor } from '@testing-library/react-native';
import { useRevenueCatIdentity } from '../useRevenueCatIdentity';

type MockAuth = { isInitialized: boolean; user: { id: string } | null; isGuest: boolean };
let mockAuth: MockAuth;
const mockIdentify = jest.fn();
const mockReset = jest.fn();
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: MockAuth) => unknown) => selector(mockAuth),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: (state: unknown) => unknown) =>
    selector({ usage: { billingUserId: 'billing-a' } }),
}));
jest.mock('@/lib/revenuecat', () => ({
  configureRevenueCat: jest.fn(),
  identifyRevenueCatUser: (...args: unknown[]) => mockIdentify(...args),
  resetRevenueCatUser: () => mockReset(),
}));

beforeEach(() => {
  mockAuth = { isInitialized: true, user: { id: 'account-a' }, isGuest: false };
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
  await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
  mockAuth = { ...mockAuth, user: null };
  rerender({});
  expect(mockReset).toHaveBeenCalledTimes(1);
});

it('retries a failed identify on the next auth update, then stops once identified', async () => {
  let failFirst!: (identified: boolean) => void;
  mockIdentify
    .mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        failFirst = resolve;
      }),
    )
    .mockResolvedValue(true);
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  failFirst(false);
  await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(1));
  // A refreshed session hands the effect a new user object.
  mockAuth = { ...mockAuth, user: { id: 'account-a' } };
  rerender({});
  await waitFor(() => expect(mockIdentify).toHaveBeenCalledTimes(2));
  await new Promise<void>((resolve) => setImmediate(resolve));
  mockAuth = { ...mockAuth, user: { id: 'account-a' } };
  rerender({});
  expect(mockIdentify).toHaveBeenCalledTimes(2);
});
