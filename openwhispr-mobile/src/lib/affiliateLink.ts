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

export function parseAffiliateLink(input: string, domain: string): URL {
  const value = input.trim();
  if (!value || value.length > 2048) throw new Error('Enter a valid OpenWhispr creator link.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid OpenWhispr creator link.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== domain ||
    url.port ||
    url.username ||
    url.password ||
    !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new Error('Enter a valid OpenWhispr creator link.');
  }
  return url;
}

// Native routing can run before auth/config hydration. Keep that explicit arrival
// until the root hook can bind it to the correct session; never navigate to its destination.
let arrival: string | null = null;
let arrivedAt = 0;
export function captureAffiliateArrival(value: string): boolean {
  const config = getAffiliateClientConfig();
  if (!config) return false;
  try {
    arrival = parseAffiliateLink(value, config.domain).toString();
    arrivedAt = Date.now();
    return true;
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
