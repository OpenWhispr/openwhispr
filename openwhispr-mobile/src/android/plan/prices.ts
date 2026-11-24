import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import type { PurchasesStoreProduct } from 'react-native-purchases';

/** The Play subscription the paywall sells (base plans `monthly` and `annual`). */
export const PRO_PRODUCT_ID = 'com.openwhispr.pro';

export interface PlayPrices {
  /** "$80.00" */
  annual: string | null;
  /** "$6.58", the annual plan's price a month. */
  annualPerMonth: string | null;
  /** "$8.00" */
  monthly: string | null;
}

type PriceState =
  // `retrying`: a Try again after a failure, which keeps the unavailable card up meanwhile.
  | { status: 'idle' | 'loading'; retrying?: boolean }
  | { status: 'loaded'; prices: PlayPrices }
  | { status: 'unavailable' };

const usePriceStore = create<PriceState>(() => ({ status: 'idle' }));

/** Reads Play's prices for the Pro base plans from the store, in the phone's currency. */
export function pricesFromProducts(products: PurchasesStoreProduct[]): PlayPrices {
  const plan = (period: string) =>
    products.find(
      (product) =>
        product.identifier.startsWith(PRO_PRODUCT_ID) && product.subscriptionPeriod === period,
    );
  const annual = plan('P1Y');
  const monthly = plan('P1M');
  return {
    annual: annual?.priceString ?? null,
    annualPerMonth: annual?.pricePerMonthString ?? null,
    monthly: monthly?.priceString ?? null,
  };
}

async function loadPrices(): Promise<void> {
  const state = usePriceStore.getState();
  if (state.status === 'loading' || state.status === 'loaded') return;
  usePriceStore.setState({
    status: 'loading',
    retrying: state.status === 'idle' && state.retrying,
  });
  try {
    // Loaded here, not at import: screens that only show a meter never touch the store.
    const { default: Purchases, PRODUCT_CATEGORY } =
      require('react-native-purchases') as typeof import('react-native-purchases');
    if (!(await Purchases.isConfigured())) throw new Error('RevenueCat is not configured');
    const products = await Purchases.getProducts([PRO_PRODUCT_ID], PRODUCT_CATEGORY.SUBSCRIPTION);
    if (!products.length) throw new Error('No Pro products from Google Play');
    usePriceStore.setState({ status: 'loaded', prices: pricesFromProducts(products) }, true);
  } catch {
    // Play Billing can't connect (no Play services, region, offline): Plan & billing's K state.
    usePriceStore.setState({ status: 'unavailable' }, true);
  }
}

/** Play's Pro prices, loaded once per run; `retry` asks Play again after a failure. */
export function usePlayPrices(enabled: boolean) {
  const state = usePriceStore();
  useEffect(() => {
    if (enabled) void loadPrices();
  }, [enabled]);
  const retry = useCallback(() => {
    usePriceStore.setState({ status: 'idle', retrying: true });
    void loadPrices();
  }, []);
  return {
    prices: state.status === 'loaded' ? state.prices : null,
    // A retry keeps showing the failure until Play answers, so the page doesn't flash the plans.
    unavailable: state.status === 'unavailable' || ('retrying' in state && !!state.retrying),
    loading: state.status === 'loading',
    retry,
  };
}
