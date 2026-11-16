import { AppState, Linking } from 'react-native';
import Purchases from 'react-native-purchases';
import type { CustomCallback, CustomCallbackResult } from 'expo-superwall';
import { requestTrackingForCreatorCode } from './affiliateAttribution';
import { getAffiliateClientConfig, parseAffiliateInput } from './affiliateLink';
import { loadAffiliateOffer, validAffiliateOffer, type AffiliateOffer } from './affiliateOffer';
import { getBillingIdentity, isBillingIdentityCurrent } from './billingIdentity';
import { getTrackingAuthorizationStatus } from './trackingTransparency';
import { getAppStorefrontCountryCode } from './revenuecat';
import { reconcileStoreBilling } from './billingReconciliation';
import { isUsageAnalyticsAllowed } from './usageAnalytics';
import { useAuthStore } from '@/store/useAuthStore';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useUsageStore } from '@/store/useUsageStore';

// Superwall callback variables are flat dictionary keys,
// including their dots, not nested objects. Keep in sync with the paywall.
export const CREATOR_INPUT_KEY = 'node.o9Et2gOJEgdSPj0nV1CkE.value';
export const CREATOR_PLAN_KEY = 'products.selectedIndex';
export const CREATOR_PRODUCT_KEY = 'products.secondary.identifier';
export const CREATOR_TOKEN_KEY = 'callbacks.creatorCodeApply.data.offerToken';
const PRICE_KEY = 'callbacks.creatorCodeApply.data.priceText';
const RENEWAL_KEY = 'callbacks.creatorCodeApply.data.renewalText';
const REQUEST_TIMEOUT_MS = 20_000;
// RevenueCat and the backend can take a few seconds to see an offer-code purchase.
const REDEMPTION_CHECK_DELAYS_MS = [0, 2_000, 5_000];
let nextPresentation = 0;
const failure = (
  message = 'We couldn’t check this code. Try again, or use the regular plan.',
): CustomCallbackResult => ({
  status: 'failure',
  data: { message },
});

export function formatAffiliateOffer(offer: AffiliateOffer) {
  const money = (amount: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency }).format(
      amount,
    );
  return {
    priceText: money(offer.offerPrice),
    renewalText: `For your first 3 monthly payments, then ${money(offer.regularPrice)}/month.`,
  };
}

/**
 * One native presentation owns one private offer. Never return the Apple URL or code.
 * Apple redeems the offer outside Superwall, so a confirmed redemption is reported
 * through `onRedeemed` rather than as a Superwall purchase.
 */
export function createAffiliatePaywallSession(
  isPresented: () => boolean,
  onRedeemed: (productId: string) => void,
  initialOffer?: AffiliateOffer,
) {
  const openingAuth = useAuthStore.getState();
  const openingUserId = openingAuth.user?.id;
  const openingCookie = openingAuth.sessionCookie;
  let identity = getBillingIdentity();
  let offerToken = `creator-${Date.now()}-${++nextPresentation}`;
  let active = true;
  let generation = 0;
  let busy = false;
  let offer: AffiliateOffer | null =
    initialOffer && identity && validAffiliateOffer(initialOffer, initialOffer.country)
      ? initialOffer
      : null;
  const initialDisplay = offer && formatAffiliateOffer(offer);
  const initialParams = initialDisplay
    ? {
        creator_offer_ready: true,
        creator_offer_price: initialDisplay.priceText,
        creator_offer_renewal: initialDisplay.renewalText,
        creator_offer_token: offerToken,
      }
    : {
        // Superwall can retain omitted placement parameters on cached reuse.
        creator_offer_ready: false,
        creator_offer_price: '',
        creator_offer_renewal: '',
        creator_offer_token: '',
      };
  let billing = false;
  let leftApp = false;
  let handoffPending = false;
  let redeemingProductId: string | null = null;
  const alive = () => {
    const auth = useAuthStore.getState();
    if (
      !active ||
      !isPresented() ||
      auth.user?.id !== openingUserId ||
      auth.sessionCookie !== openingCookie
    )
      return false;
    // Usage can finish loading after anonymous onboarding presents its paywall.
    // Bind billing ownership once, without ever rebinding the opening account.
    identity ??= getBillingIdentity();
    return identity !== null && isBillingIdentityCurrent(identity);
  };
  const eligible = () =>
    alive() &&
    !useUsageStore.getState().usage?.isSubscribed &&
    isUsageAnalyticsAllowed(useConfigStore.getState().config);
  const permission = async () => {
    const status = await getTrackingAuthorizationStatus();
    return eligible() && (status === 'authorized' || status === 'notSupported');
  };
  // Keeps Use code locked until the purchase is confirmed or the checks run out,
  // so a single-use code that was already redeemed can't be opened again.
  const confirmRedemption = async (productId: string) => {
    try {
      for (const delay of REDEMPTION_CHECK_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!alive()) return;
        await reconcileStoreBilling().catch(() => {
          /* Ordinary restore/reconciliation remains available on a later visit. */
        });
        if (!alive()) return;
        await useUsageStore.getState().load(true);
        if (alive() && useUsageStore.getState().usage?.isSubscribed) {
          onRedeemed(productId);
          return;
        }
      }
    } finally {
      handoffPending = false;
    }
  };
  const subscription = AppState.addEventListener('change', (state) => {
    if (!billing || !alive()) return;
    if (state === 'background') leftApp = true;
    if (state !== 'active' || !leftApp || !redeemingProductId) return;
    leftApp = false;
    const productId = redeemingProductId;
    redeemingProductId = null;
    confirmRedemption(productId).catch(() => {});
  });
  const close = () => {
    active = false;
    generation += 1;
    offer = null;
    subscription.remove();
    if (billing) {
      billing = false;
      useUsageStore.getState().endBillingSession();
    }
  };
  const handle = async (callback: CustomCallback): Promise<CustomCallbackResult> => {
    const variables = callback.variables;
    if (
      !eligible() ||
      !getAffiliateClientConfig() ||
      busy ||
      !variables ||
      variables[CREATOR_PLAN_KEY] !== 1 ||
      typeof variables[CREATOR_PRODUCT_KEY] !== 'string' ||
      !variables[CREATOR_PRODUCT_KEY]
    )
      return failure();
    if (callback.name !== 'creatorCodeApply' && callback.name !== 'creatorOfferRedeem')
      return failure();
    if (callback.name === 'creatorOfferRedeem' && handoffPending)
      return failure('We’re still checking your purchase. Try again in a moment.');
    busy = true;
    const version = ++generation;
    const current = () => eligible() && generation === version;
    let timer: ReturnType<typeof setTimeout>;
    const work = async (): Promise<CustomCallbackResult> => {
      if (
        callback.name === 'creatorCodeApply' &&
        isUsageAnalyticsAllowed(useConfigStore.getState().config)
      )
        await requestTrackingForCreatorCode();
      if (!(await permission()) || !current())
        return failure(
          'Creator codes are unavailable with your current tracking settings. You can use the regular plan.',
        );
      if (callback.name === 'creatorCodeApply') {
        // A refused apply keeps the offer already on screen redeemable.
        const input = variables[CREATOR_INPUT_KEY];
        const config = getAffiliateClientConfig();
        if (typeof input !== 'string' || input.length > 2048 || !config) return failure();
        const key = parseAffiliateInput(input, config.domain).pathname;
        await useAffiliateStore.getState().hydrate();
        await useAffiliateStore.getState().bindSession();
        if (!current()) return failure();
        const saved = useAffiliateStore.getState();
        if (saved.checking) return failure();
        if (saved.saved && parseAffiliateInput(saved.link, config.domain).pathname !== key)
          return failure('Your first creator is already saved and can’t be changed.');
        if (!saved.saved) await saved.edit(input);
        if (
          !current() ||
          parseAffiliateInput(useAffiliateStore.getState().link, config.domain).pathname !== key
        )
          return failure();
        if (
          !(await useAffiliateStore.getState().prepare(current)) ||
          !current() ||
          !useAffiliateStore.getState().saved
        )
          return failure();
        const loaded = await loadAffiliateOffer(current);
        if (
          !loaded ||
          !(await permission()) ||
          !current() ||
          !validAffiliateOffer(loaded, loaded.country) ||
          loaded.productId !== variables[CREATOR_PRODUCT_KEY]
        )
          return failure(
            'Your creator is saved, but a monthly offer isn’t available now. You can use the regular plan.',
          );
        offer = loaded;
        offerToken = `creator-${Date.now()}-${++nextPresentation}`;
        return { status: 'success', data: { ...formatAffiliateOffer(loaded), offerToken } };
      }
      const held = offer;
      const shownToken = variables[CREATOR_TOKEN_KEY] || variables['params.creator_offer_token'];
      const shownPrice = variables[PRICE_KEY] || variables['params.creator_offer_price'];
      const shownRenewal = variables[RENEWAL_KEY] || variables['params.creator_offer_renewal'];
      if (!held || shownToken !== offerToken || variables[CREATOR_PRODUCT_KEY] !== held.productId)
        return failure();
      const display = formatAffiliateOffer(held);
      if (shownPrice !== display.priceText || shownRenewal !== display.renewalText)
        return failure();
      const country = await getAppStorefrontCountryCode();
      if (
        !current() ||
        !country ||
        !validAffiliateOffer(held, country) ||
        (await Purchases.getAppUserID()) !== identity?.billingUserId
      )
        return failure();
      const products = await Purchases.getProducts([held.productId]);
      const product = products.find((item) => item.identifier === held.productId);
      if (
        !current() ||
        !product ||
        product.subscriptionPeriod !== 'P1M' ||
        product.currencyCode !== held.currency ||
        Math.abs(product.price - held.regularPrice) > 0.000001 ||
        !(await permission()) ||
        !current() ||
        Date.parse(held.expiresAt) <= Date.now()
      )
        return failure();
      // RootLayout consumes the resume guard after each Apple return.
      useUsageStore.getState().beginBillingSession();
      billing = true;
      handoffPending = true;
      redeemingProductId = held.productId;
      try {
        await Linking.openURL(held.redemptionUrl);
      } catch (error) {
        handoffPending = false;
        redeemingProductId = null;
        throw error;
      }
      return current() ? { status: 'success' } : failure();
    };
    const timeout = new Promise<CustomCallbackResult>((resolve) => {
      timer = setTimeout(() => {
        // The offer already on screen stays redeemable; only this request is abandoned.
        if (generation === version) {
          generation += 1;
          busy = false;
        }
        resolve(failure());
      }, REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work().catch(() => failure()), timeout]);
    } finally {
      clearTimeout(timer!);
      if (generation === version) busy = false;
    }
  };
  return { handle, close, initialParams };
}
