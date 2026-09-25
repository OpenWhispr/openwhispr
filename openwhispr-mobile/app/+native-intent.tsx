import { captureAffiliateArrival } from '@/lib/affiliateLink';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return captureAffiliateArrival(path) ? '/' : path;
}
