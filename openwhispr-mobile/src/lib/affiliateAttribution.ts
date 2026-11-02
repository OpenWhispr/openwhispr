import { api } from './apiClient';
import { getAffiliateClientConfig, parseAffiliateInput } from './affiliateLink';
import { setAppsFlyerTrackingAuthorizationStatus } from './appsflyer';
import {
  getTrackingAuthorizationStatus,
  requestTrackingAuthorization,
} from './trackingTransparency';

export type AffiliateClaimStatus = 'provisional' | 'pending' | 'registered' | 'review';
export class AffiliateConsentError extends Error {}

type DubOpen = { clickId?: string; link?: { domain?: string; key?: string } };

// The one Dub call the app needs. Its SDK would add native clipboard and
// install-referrer modules, and reads the clipboard when no URL is passed.
async function trackDubOpen(
  config: { domain: string; publishableKey: string },
  deepLink: string,
  signal: AbortSignal,
): Promise<DubOpen> {
  const response = await fetch('https://api.dub.co/track/open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.publishableKey}`,
    },
    body: JSON.stringify({ dubDomain: config.domain, deepLink }),
    signal,
  });
  if (!response.ok) throw new Error('We couldn’t check your link. Try again.');
  return (await response.json()) as DubOpen;
}

// An explicit creator-code submission is the moment to ask, if iOS hasn't asked yet.
export async function requestTrackingForCreatorCode(): Promise<void> {
  if ((await getTrackingAuthorizationStatus()) !== 'notDetermined') return;
  setAppsFlyerTrackingAuthorizationStatus(await requestTrackingAuthorization());
}

async function requireTrackingPermission(): Promise<void> {
  const status = await getTrackingAuthorizationStatus();
  if (status !== 'authorized' && status !== 'notSupported') throw new AffiliateConsentError();
}

export async function checkAndClaimAffiliate(
  input: string,
  clickId: string | null,
  sessionCookie: string,
  isCurrent: () => boolean,
  rememberClick: (clickId: string) => Promise<void>,
): Promise<AffiliateClaimStatus> {
  const config = getAffiliateClientConfig();
  if (!config) throw new Error('Creator links are not available yet.');
  const link = parseAffiliateInput(input, config.domain).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const options = {
    authenticated: false,
    headers: { Cookie: sessionCookie },
    signal: controller.signal,
  };
  const assertCurrent = () => {
    if (!isCurrent() || controller.signal.aborted)
      throw new Error('Referral check interrupted. Try again.');
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    assertCurrent();
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(new Error('Referral check interrupted. Try again.'));
      controller.signal.addEventListener('abort', rejectAborted, { once: true });
    });
    return Promise.race([work, aborted]).finally(() => {
      controller.signal.removeEventListener('abort', rejectAborted);
    });
  };
  try {
    await bounded(requireTrackingPermission());
    assertCurrent();
    await bounded(api.post('/api/affiliate/check-link', { link }, options));
    assertCurrent();
    if (!clickId) {
      await bounded(requireTrackingPermission());
      assertCurrent();
      const result = await bounded(trackDubOpen(config, link, controller.signal));
      assertCurrent();
      if (
        !result.clickId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(result.clickId) ||
        result.link?.domain !== config.domain ||
        `/${result.link.key}` !== new URL(link).pathname
      ) {
        throw new Error('We couldn’t check your link. Try again.');
      }
      clickId = result.clickId;
      await bounded(rememberClick(clickId));
      assertCurrent();
    }
    await bounded(requireTrackingPermission());
    assertCurrent();
    const result = await bounded(
      api.post<{ data: { status: AffiliateClaimStatus; persisted: true } }>(
        '/api/affiliate/claim',
        { link, clickId, source: 'mobile' },
        options,
      ),
    );
    // The server has acted on the claim by now, so report its answer even if the
    // caller moved on; the store decides whether that answer still belongs to it.
    if (
      !result.data?.persisted ||
      !['provisional', 'pending', 'registered', 'review'].includes(result.data.status)
    ) {
      throw new Error('We couldn’t save your link. Try again.');
    }
    return result.data.status;
  } finally {
    clearTimeout(timeout);
  }
}
