import { act, renderHook, waitFor } from '@testing-library/react-native';
import { usePlayPrices } from '../plan/prices';

const mockGetProducts = jest.fn();
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    isConfigured: () => Promise.resolve(true),
    getProducts: (...args: unknown[]) => mockGetProducts(...args),
  },
  PRODUCT_CATEGORY: { SUBSCRIPTION: 'SUBSCRIPTION' },
}));

const annual = {
  identifier: 'com.openwhispr.pro:annual',
  subscriptionPeriod: 'P1Y',
  priceString: '$80.00',
  pricePerMonthString: '$6.67',
};

it('keeps the unavailable state through a retry until Play answers', async () => {
  mockGetProducts.mockRejectedValueOnce(new Error('Billing unavailable'));
  const { result } = renderHook(() => usePlayPrices(true));
  await waitFor(() => expect(result.current.unavailable).toBe(true));

  let answer: (products: unknown[]) => void = () => undefined;
  mockGetProducts.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  act(() => result.current.retry());
  // While Play is asked again the page must not flash the plans and their price.
  expect(result.current.unavailable).toBe(true);
  expect(result.current.loading).toBe(true);

  await act(async () => answer([annual]));
  expect(result.current.unavailable).toBe(false);
  expect(result.current.prices?.annualPerMonth).toBe('$6.67');
});
