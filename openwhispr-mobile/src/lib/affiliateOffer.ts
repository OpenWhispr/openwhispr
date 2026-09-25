import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import { api } from './apiClient';
import { getAffiliateClientConfig } from './affiliateLink';
import { getAppStorefrontCountryCode } from './revenuecat';
import { useConfigStore } from '@/store/useConfigStore';
import { getTrackingAuthorizationStatus } from './trackingTransparency';
import { useUsageStore } from '@/store/useUsageStore';
import { getBillingIdentity, isBillingIdentityCurrent } from './billingIdentity';

export interface AffiliateOffer {
  campaign: string;
  productId: string;
  country: string;
  currency: string;
  regularPrice: number;
  offerPrice: number;
  months: 3;
  redemptionUrl: string;
  expiresAt: string;
}
export function validAffiliateOffer(value: unknown, country: string): value is AffiliateOffer {
  if (!value || typeof value !== 'object') return false;
  const v = value as AffiliateOffer;
  try {
    const url = new URL(v.redemptionUrl);
    const digits =
      new Intl.NumberFormat('en', { style: 'currency', currency: v.currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    return (
      typeof v.campaign === 'string' &&
      typeof v.productId === 'string' &&
      v.country === country &&
      /^[A-Z]{3}$/.test(v.currency) &&
      v.months === 3 &&
      Number.isFinite(v.regularPrice) &&
      v.regularPrice > 0 &&
      Number.isFinite(v.offerPrice) &&
      Math.abs(v.offerPrice * 10 ** digits - Math.round(v.regularPrice * 10 ** digits * 0.8)) <
        0.000001 &&
      Date.parse(v.expiresAt) > Date.now() &&
      url.protocol === 'https:' &&
      url.hostname === 'apps.apple.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/redeem' &&
      url.searchParams.get('ctx') === 'offercodes' &&
      /^\d+$/.test(url.searchParams.get('id') ?? '') &&
      /^[A-Za-z0-9]+$/.test(url.searchParams.get('code') ?? '')
    );
  } catch {
    return false;
  }
}
export async function loadAffiliateOffer(
  isCallerCurrent: () => boolean = () => true,
): Promise<AffiliateOffer | null> {
  if (Platform.OS !== 'ios' || !getAffiliateClientConfig() || !isCallerCurrent()) return null;
  const identity = getBillingIdentity();
  if (!identity || useUsageStore.getState().usage?.isSubscribed) return null;
  const { sessionCookie, billingUserId } = identity;
  const current = () =>
    isCallerCurrent() &&
    useConfigStore.getState().config?.usageAnalyticsEnabled === true &&
    isBillingIdentityCurrent(identity) &&
    !useUsageStore.getState().usage?.isSubscribed;
  let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, 8000);
  });
  const permitted = async () => {
    const status = await getTrackingAuthorizationStatus();
    return (
      current() &&
      !controller.signal.aborted &&
      (status === 'authorized' || status === 'notSupported')
    );
  };
  const work = (async () => {
    if (!(await permitted())) return null;
    const country = await getAppStorefrontCountryCode();
    if (
      !country ||
      !current() ||
      controller.signal.aborted ||
      (await Purchases.getAppUserID()) !== billingUserId
    )
      return null;
    if (!(await permitted())) return null;
    const result = await api.post<{ data: unknown }>(
      '/api/affiliate/apple-offer',
      { country },
      { authenticated: false, headers: { Cookie: sessionCookie }, signal: controller.signal },
    );
    if (!current() || controller.signal.aborted || !validAffiliateOffer(result.data, country))
      return null;
    const offer = result.data;
    const products = await Purchases.getProducts([offer.productId]);
    const product = products.find((p) => p.identifier === offer.productId);
    if (
      !current() ||
      controller.signal.aborted ||
      !product ||
      product.currencyCode !== offer.currency ||
      Math.abs(product.price - offer.regularPrice) > 0.000001 ||
      product.subscriptionPeriod !== 'P1M'
    )
      return null;
    return (await permitted()) && validAffiliateOffer(offer, country) ? offer : null;
  })().catch(() => null);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
