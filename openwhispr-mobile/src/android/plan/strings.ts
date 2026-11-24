import i18n from '../strings';
import { useTranslation } from 'react-i18next';
import { planTranslations } from './translations';

// Plan & billing, the words meters and the upgrade doors. Kept out of the shared locale files,
// which the iOS app loads.
export const planEnglish = {
  // Status chips above a plan's name
  chipYourPlan: 'Your plan',
  chipBusiness: 'Business',
  chipConfirming: 'Confirming',
  chipPaymentPending: 'Payment pending',
  chipTakingLonger: 'Taking longer',
  chipEnds: 'Ends {{date}}',
  chipActionNeeded: 'Action needed',
  chipNotSignedIn: 'Not signed in',
  // Plan names
  free: 'Free',
  pro: 'Pro',
  business: 'Business',
  // The words meter
  cloudWordsThisWeek: 'Cloud words this week',
  unlimited: 'Unlimited',
  rollingAllowance: 'Rolling 7-day allowance',
  goUnlimited: 'Go unlimited',
  // A · Free, B · out of words
  freeBody:
    'Unlimited on-device dictation, plus {{limit}} cloud words a week for AI cleanup and the assistant.',
  freeOutBody: 'You’ve used this week’s cloud words. On-device dictation still works.',
  proAdds: 'Pro adds',
  addWords: 'Unlimited cloud words',
  addWordsBody: 'No weekly cap on dictation or cleanup',
  addAssistant: 'AI cleanup and the assistant',
  addAssistantBody: 'Without counting words',
  addDevices: 'Notes on every device',
  addDevicesBody: 'Synced with desktop and iPhone',
  addMeetings: 'Cloud meeting notes',
  addMeetingsBody: 'Transcripts and summaries',
  seeProPlans: 'See Pro plans',
  fromPrice: 'From {{price}} a month, billed yearly. Cancel anytime in Google Play.',
  restorePurchases: 'Restore purchases',
  // Confirming a purchase
  unlockingTitle: 'Unlocking Pro',
  unlockingBody:
    'Google Play has your payment. We’re adding Pro to your account. This usually takes a few seconds.',
  paidWithPlay: 'Paid with Google Play',
  addingPro: 'Adding Pro to your account',
  addingProBody: 'You can leave this screen. We’ll tell you when it’s done.',
  pendingTitle: 'Waiting for Google Play',
  pendingBody:
    'Your payment is still processing. Some cards and cash payments take up to 3 days. Pro unlocks as soon as it clears, and you won’t be charged twice.',
  openGooglePlay: 'Open Google Play',
  onItsWayTitle: 'Pro is on its way',
  onItsWayBody:
    'Google Play confirmed your payment, but Pro hasn’t reached your account yet. Your payment is safe.',
  checkAgain: 'Check again',
  getHelp: 'Get help',
  contactSupport: 'Contact support',
  proToast: 'You’re on Pro. Cloud words are unlimited.',
  // C · Pro on Google Play, D · cancelled, E · payment problem
  renews: 'Renews {{date}}',
  renewsPrice: 'Renews {{date}} · {{price}}',
  priceYear: '{{price}} a year',
  priceMonth: '{{price}} a month',
  subscription: 'Subscription',
  manageSubscription: 'Manage subscription',
  manageSubscriptionBody: 'Change plan or cancel in Google Play',
  cancelledTitle: 'Pro until {{date}}',
  cancelledTitleNoDate: 'Pro until your plan ends',
  cancelledBody: 'You cancelled in Google Play. You keep Pro until then, then move to Free.',
  keepPro: 'Keep Pro',
  problemTitle: 'Update your payment',
  problemBody: 'Google Play couldn’t charge your card. Update it to keep Pro.',
  fixPayment: 'Fix payment in Google Play',
  trialEnds: 'Trial ends {{date}}',
  // G · web, H · workspace, I · App Store
  webBody: 'Billed on openwhispr.com.',
  webRenews: 'Billed on openwhispr.com. Renews {{date}}.',
  manageWeb: 'Manage on openwhispr.com',
  manageWebBody: 'Invoices, payment method, cancel',
  workspaceTitle: 'Covered by your workspace',
  workspaceBody: 'Your workspace pays for your plan. Ask a workspace admin to make changes.',
  workspace: 'Workspace',
  workspaceRow: 'Your workspace',
  workspaceRowBody: 'You’re a member',
  appStoreBody: 'Billed by the App Store. Manage it in your Apple account on iPhone or iPad.',
  billedByApple: 'Billed by Apple',
  billedByAppleBody: 'Can’t be changed from Android',
  // J · signed out, K · billing unavailable, L · restore found nothing
  signInTitle: 'Sign in to see your plan',
  signInBody: 'On-device dictation works without an account. Pro and cloud words need one.',
  signIn: 'Sign in',
  storeUnavailable:
    'Google Play isn’t available right now, so plans can’t load. Check your connection and try again.',
  tryAgain: 'Try again',
  noPurchase: 'No purchase found for this Google account',
  restored: 'Purchase restored',
  checkingPlan: 'Checking your plan…',
  planUnavailable: 'Couldn’t load your plan. Check your connection and try again.',
  // Settings' Plan & billing row
  settingsPlanBody: 'Unlimited cloud words with Pro',
};

export type PlanKey = keyof typeof planEnglish;
export const PLAN_NAMESPACE = 'androidPlan';

i18n.addResourceBundle('en', PLAN_NAMESPACE, planEnglish, true, false);
for (const [language, strings] of Object.entries(planTranslations))
  i18n.addResourceBundle(language, PLAN_NAMESPACE, strings, true, false);

export type PlanT = (key: PlanKey, options?: Record<string, unknown>) => string;

export function usePlanT(): PlanT {
  const { t } = useTranslation(PLAN_NAMESPACE);
  return (key, options) => t(key, options) as string;
}
