import Constants from 'expo-constants';
import { Platform } from 'react-native';

export function getAffiliateClientConfig(): { domain: string; publishableKey: string } | null {
  if (Platform.OS !== 'ios') return null;
  const config = Constants.expoConfig?.extra?.affiliate;
  if (
    !config ||
    typeof config.domain !== 'string' ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(config.domain) ||
    typeof config.publishableKey !== 'string' ||
    !config.publishableKey.startsWith('dub_pk_')
  )
    return null;
  return { domain: config.domain, publishableKey: config.publishableKey };
}

export class AffiliateInputError extends Error {
  constructor() {
    super('Enter a valid OpenWhispr creator link.');
  }
}

export function parseAffiliateLink(input: string, domain: string): URL {
  const value = input.trim();
  if (!value || value.length > 2048) throw new AffiliateInputError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AffiliateInputError();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== domain ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new AffiliateInputError();
  }
  return url;
}

// Short entry is an exact lowercase key, not case folding of a creator identity.
// Full links preserve their original key case and strict trusted-domain checks.
export function parseAffiliateInput(input: string, domain: string): URL {
  const value = input.trim();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    return parseAffiliateLink(`https://${domain}/${value}`, domain);
  }
  return parseAffiliateLink(value, domain);
}

// Native routing can run before auth/config hydration. Keep that explicit arrival
// until the root hook can bind it to the correct session; never navigate to its destination.
let arrival: string | null = null;
let arrivedAt = 0;
export function captureAffiliateArrival(value: string): boolean {
  const config = getAffiliateClientConfig();
  if (!config) return false;
  try {
    const url = new URL(value.trim());
    // Share sheets can append a slash to a short link.
    url.pathname = url.pathname.replace(/^(\/[^/]+)\/$/, '$1');
    arrival = parseAffiliateLink(url.toString(), config.domain).toString();
    arrivedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

// The creator domain has no app screens, so none of its links may open as a route.
export function isAffiliateDomainLink(value: string): boolean {
  const config = getAffiliateClientConfig();
  if (!config) return false;
  try {
    return new URL(value).hostname === config.domain;
  } catch {
    return false;
  }
}
export function consumeAffiliateArrival(): string | null {
  const value = arrival;
  arrival = null;
  return value;
}
export function isAffiliateArrivalFresh(): boolean {
  const age = Date.now() - arrivedAt;
  return arrivedAt > 0 && age >= 0 && age < 5000;
}
