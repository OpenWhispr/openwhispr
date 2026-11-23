import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { launchTranslations } from './translations';

// Launch copy (slow open, couldn't open, signed out, returning account) lives here rather than in
// the shared locale files, which the iOS app loads.
export const launchEnglish = {
  opening: 'Opening your workspace…',
  couldNotOpen: 'OpenWhispr couldn’t open',
  couldNotOpenBody:
    'Your notes and recordings are still on this phone. Try again, or restart your phone if it keeps happening.',
  tryAgain: 'Try again',
  copyDetails: 'Copy details for support',
  detailsCopied: 'Details copied',
  signedOutTitle: 'You’ve been signed out',
  signedOutBody:
    'Your sign-in on this phone ended, maybe after a password change. Sign in again to keep syncing. Everything on this phone is still here.',
  signInAgain: 'Sign in again',
  notNow: 'Not now',
  seeHowItWorks: 'See how it works',
};

export type LaunchKey = keyof typeof launchEnglish;
export const LAUNCH_NAMESPACE = 'androidLaunch';

i18n.addResourceBundle('en', LAUNCH_NAMESPACE, launchEnglish, true, false);
for (const [language, strings] of Object.entries(launchTranslations))
  i18n.addResourceBundle(language, LAUNCH_NAMESPACE, strings, true, false);

export type LaunchT = (key: LaunchKey, options?: Record<string, unknown>) => string;

export function useLaunchT(): LaunchT {
  const { t } = useTranslation(LAUNCH_NAMESPACE);
  return (key, options) => t(key, options) as string;
}
