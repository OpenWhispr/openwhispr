import { renderHook } from '@testing-library/react-native';
import { useRevenueCatIdentity } from '../useRevenueCatIdentity';

let mockAuth = {
  isInitialized: true,
  user: { id: 'account-a' } as { id: string } | null,
  isGuest: false,
};
const mockIdentify = jest.fn();
const mockReset = jest.fn();
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof mockAuth) => unknown) => selector(mockAuth),
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

it('queues logout even if the previous identify has not resolved', () => {
  mockIdentify.mockReturnValue(new Promise(() => {}));
  const { rerender } = renderHook(() => useRevenueCatIdentity());
  expect(mockIdentify).toHaveBeenCalledWith('billing-a');
  mockAuth = { ...mockAuth, user: null };
  rerender({});
  expect(mockReset).toHaveBeenCalledTimes(1);
});
