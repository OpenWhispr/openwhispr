import dub from '@dub/react-native';
import { api } from './apiClient';
import { getAffiliateClientConfig, parseAffiliateInput } from './affiliateLink';
import { getTrackingAuthorizationStatus } from './trackingTransparency';

export type AffiliateClaimStatus = 'provisional' | 'pending' | 'registered' | 'review';
export class AffiliateConsentError extends Error {}

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
      dub.init(config);
      // Always pass the explicit URL. Calling without one enables SDK clipboard/IP fallback.
      const result = await bounded(dub.trackOpen(link));
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
    assertCurrent();
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
