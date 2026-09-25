import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import {
  captureAffiliateArrival,
  consumeAffiliateArrival,
  getAffiliateClientConfig,
} from '@/lib/affiliateLink';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';

export function useAffiliateAttribution(): void {
  useEffect(() => {
    if (!getAffiliateClientConfig()) return;
    let stopped = false;
    let running = false;
    let pending = false;
    async function reconcile() {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !stopped) {
          pending = false;
          await useAffiliateStore.getState().hydrate();
          if (
            stopped ||
            !useAuthStore.getState().isInitialized ||
            !useConfigStore.getState().config
          )
            break;
          await useAffiliateStore.getState().bindSession();
          const link = consumeAffiliateArrival();
          if (link) await useAffiliateStore.getState().edit(link, true);
          if (useAffiliateStore.getState().autoSubmit) await useAffiliateStore.getState().prepare();
        }
      } finally {
        running = false;
      }
    }
    const onLink = (url: string) => {
      if (captureAffiliateArrival(url)) reconcile().catch(() => {});
    };
    const linkSub = Linking.addEventListener('url', ({ url }) => onLink(url));
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reconcile().catch(() => {});
    });
    const authSub = useAuthStore.subscribe(() => {
      useAffiliateStore
        .getState()
        .bindSession()
        .then(reconcile)
        .catch(() => {});
    });
    const configSub = useConfigStore.subscribe(() => {
      reconcile().catch(() => {});
    });
    Linking.getInitialURL()
      .then((url) => {
        if (!stopped && url) onLink(url);
      })
      .catch(() => {});
    reconcile().catch(() => {});
    return () => {
      stopped = true;
      linkSub.remove();
      appSub.remove();
      authSub();
      configSub();
    };
  }, []);
}
