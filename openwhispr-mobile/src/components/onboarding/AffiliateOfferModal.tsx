import { useEffect, useState } from 'react';
import { AppState, Linking, Modal, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from './OnboardingShell';
import { PaywallHighlights } from './PaywallHighlights';
import { useAffiliateOfferStore, closeAffiliateOffer } from '@/store/useAffiliateOfferStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { isBillingIdentityCurrent } from '@/lib/billingIdentity';

export function AffiliateOfferModal() {
  const { offer, identity } = useAffiliateOfferStore();
  const userId = useAuthStore((s) => s.user?.id);
  const sessionCookie = useAuthStore((s) => s.sessionCookie);
  const billingUserId = useUsageStore((s) => s.usage?.billingUserId);
  const subscribed = useUsageStore((s) => s.usage?.isSubscribed ?? false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (offer && (!identity || !isBillingIdentityCurrent(identity) || subscribed))
      closeAffiliateOffer();
  }, [offer, identity, userId, sessionCookie, billingUserId, subscribed]);
  useEffect(() => {
    if (!offer || !identity) return;
    setError(null);
    let stopped = false;
    let leftApp = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') leftApp = true;
      if (state === 'active' && leftApp) {
        leftApp = false;
        if (stopped || !isBillingIdentityCurrent(identity)) return;
        reconcileStoreBilling()
          .then(() => {
            if (!stopped && isBillingIdentityCurrent(identity))
              return useUsageStore.getState().load(true);
          })
          .catch(() => {
            if (!stopped && isBillingIdentityCurrent(identity))
              setError(
                'We couldn’t verify your purchase yet. Restart the app and restore purchases in Plans & Billing.',
              );
          });
      }
    });
    return () => {
      stopped = true;
      sub.remove();
    };
  }, [offer, identity]);
  if (!offer || !identity) return null;
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency }).format(value);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={closeAffiliateOffer}
    >
      <OnboardingShell
        title="Go further with OpenWhispr Pro."
        titleAccent="Pro"
        subtitle="Your monthly offer is available."
        ctaLabel="Continue with monthly offer"
        ctaLoading={opening}
        onCta={async () => {
          setOpening(true);
          setError(null);
          try {
            if (
              !isBillingIdentityCurrent(identity) ||
              useUsageStore.getState().usage?.isSubscribed
            ) {
              closeAffiliateOffer();
              return;
            }
            useUsageStore.getState().beginBillingSession();
            if (Date.parse(offer.expiresAt) <= Date.now()) throw new Error('expired');
            await Linking.openURL(offer.redemptionUrl);
          } catch {
            setError('We couldn’t open this offer. Please try again.');
          } finally {
            setOpening(false);
          }
        }}
        secondaryCtaLabel="Not now"
        onSecondaryCta={closeAffiliateOffer}
      >
        <ScrollView contentContainerClassName="gap-6 pb-6">
          <PaywallHighlights />
          <View className="gap-4 rounded-[24px] border-2 border-primary bg-secondarySystemBackground p-6">
            <Text className="text-[18px] font-medium text-primary">20% off for 3 months</Text>
            <View className="flex-row flex-wrap items-baseline gap-2">
              <Text className="text-[40px] font-semibold text-label">
                {money(offer.offerPrice)}
              </Text>
              <Text className="text-[18px] text-label">/ month</Text>
            </View>
            <Text className="text-[16px] leading-6 text-secondaryLabel">
              For your first 3 monthly payments, then {money(offer.regularPrice)}/month.
            </Text>
          </View>
          <Text className="text-[15px] leading-6 text-secondaryLabel">
            Review the offer and renewal price in Apple’s confirmation before you subscribe.
          </Text>
          {error && (
            <Text accessibilityRole="alert" className="text-destructive">
              {error}
            </Text>
          )}
        </ScrollView>
      </OnboardingShell>
    </Modal>
  );
}
