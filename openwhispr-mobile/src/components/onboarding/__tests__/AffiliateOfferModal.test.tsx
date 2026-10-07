jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { AffiliateOfferModal } from '../AffiliateOfferModal';

const mockOffer = {
  offer: { currency: 'USD', offerPrice: 7.99, regularPrice: 9.99 },
  identity: { userId: 'buyer', sessionCookie: 'session', billingUserId: 'billing' },
};
let mockOwner = 'buyer';
const mockLoad = jest.fn();
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/Button', () => ({ Button: require('react-native').Text }));
jest.mock('@/store/useAffiliateOfferStore', () => ({
  useAffiliateOfferStore: () => mockOffer,
  closeAffiliateOffer: jest.fn(),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: { id: string }; sessionCookie: string }) => unknown) =>
      selector({ user: { id: mockOwner }, sessionCookie: 'session' }),
    { getState: () => ({ user: { id: mockOwner }, sessionCookie: 'session' }) },
  ),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (s: { usage: null }) => unknown) => selector({ usage: null }),
    { getState: () => ({ load: mockLoad, usage: { billingUserId: 'billing' } }) },
  ),
}));
jest.mock('@/lib/billingReconciliation', () => ({ reconcileStoreBilling: jest.fn() }));

let onState: (status: AppStateStatus) => void;
const usage = {} as Awaited<ReturnType<typeof reconcileStoreBilling>>;
beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'buyer';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onState = listener;
    return { remove: jest.fn() };
  });
  jest.mocked(reconcileStoreBilling).mockResolvedValue(usage);
});
afterEach(() => jest.restoreAllMocks());

it('does not start reconciliation for an account that changed while Apple was open', () => {
  render(<AffiliateOfferModal />);
  act(() => onState('background'));
  mockOwner = 'other';
  act(() => onState('active'));
  expect(reconcileStoreBilling).not.toHaveBeenCalled();
  expect(mockLoad).not.toHaveBeenCalled();
});

it('does not refresh a different account after a delayed reconciliation response', async () => {
  let finish!: (value: typeof usage) => void;
  jest.mocked(reconcileStoreBilling).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AffiliateOfferModal />);
  act(() => {
    onState('background');
    onState('active');
  });
  expect(reconcileStoreBilling).toHaveBeenCalledTimes(1);
  mockOwner = 'other';
  await act(async () => {
    finish(usage);
  });
  expect(mockLoad).not.toHaveBeenCalled();
});
