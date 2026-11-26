import { captureAffiliateArrival, isAffiliateDomainLink } from '@/android/shared/lib/affiliateLink';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return captureAffiliateArrival(path) || isAffiliateDomainLink(path) ? '/' : path;
}
