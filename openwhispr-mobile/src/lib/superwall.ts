import Constants from 'expo-constants';
import type { SubscriptionStatus } from 'expo-superwall';
import type { UsageInfo } from '@/data/remote/usageApi';
import type { ProcessingMode } from '@/types';

export const SUPERWALL_APP_ENTITLEMENT_ID = 'pro';
export const SUPERWALL_WORDS_REMAINING_SENTINEL = 1_000_000_000;

export const SUPERWALL_PLACEMENTS = {
  onboardingPaywall: 'onboarding_paywall',
  accountBillingOpen: 'account_billing_open',
  cloudUsageWarningTapped: 'cloud_usage_warning_tapped',
  cloudUsageLimitReached: 'cloud_usage_limit_reached',
  cloudSyncRequired: 'cloud_sync_required',
  cloudTranscriptionStart: 'cloud_transcription_start',
  audioUploadStart: 'audio_upload_start',
  noteDictationStart: 'note_dictation_start',
  aiActionRun: 'ai_action_run',
  noteChatStart: 'note_chat_start',
  meetingRecordStart: 'meeting_record_start',
  voiceProfileAdditionalSpeaker: 'voice_profile_additional_speaker',
} as const;

export type SuperwallPlacement = (typeof SUPERWALL_PLACEMENTS)[keyof typeof SUPERWALL_PLACEMENTS];

// Transactional placements require an account and fail closed. onboardingPaywall
// is deliberately absent from both: it must never bounce to sign-in (the account
// step comes after it) and must let the user through if Superwall is missing,
// misconfigured, or errors — a dead-end there would trap the whole first run.
const TRANSACTIONAL_PLACEMENTS = new Set<SuperwallPlacement>([
  SUPERWALL_PLACEMENTS.accountBillingOpen,
  SUPERWALL_PLACEMENTS.cloudUsageWarningTapped,
  SUPERWALL_PLACEMENTS.cloudUsageLimitReached,
  SUPERWALL_PLACEMENTS.cloudSyncRequired,
]);

type AppInfo = {
  appEnvironment: string;
  appVersion: string;
};

export type SuperwallAttributes = Record<string, string | number | boolean | null>;

type BuildSuperwallAttributesInput = {
  usage: UsageInfo;
  activeMode: ProcessingMode;
  appInfo?: AppInfo;
};

type ExpoExtra = {
  openWhispr?: {
    appEnvironment?: string;
  };
};

export function isTransactionalSuperwallPlacement(placement: SuperwallPlacement): boolean {
  return TRANSACTIONAL_PLACEMENTS.has(placement);
}

export function buildSuperwallSubscriptionStatus(usage: UsageInfo): SubscriptionStatus {
  if (!usage.isSubscribed) {
    return { status: 'INACTIVE' };
  }

  return {
    status: 'ACTIVE',
    entitlements: [{ id: SUPERWALL_APP_ENTITLEMENT_ID, type: 'SERVICE_LEVEL' }],
  };
}

export function serializeSuperwallSubscriptionStatus(status: SubscriptionStatus): string {
  if (status.status !== 'ACTIVE') return status.status;
  const entitlements = status.entitlements
    .map((entitlement) => `${entitlement.type}:${entitlement.id}`)
    .sort()
    .join(',');
  return `${status.status}:${entitlements}`;
}

// Per-placement params snapshot of the usage state driving a gate. Unlike
// buildSuperwallAttributes, wordsRemaining is the raw backend value (clamped
// to 0) even for subscribers — the placement should see what the user sees.
export function buildUsageGateParams(usage: UsageInfo): SuperwallAttributes {
  return {
    wordsUsed: usage.wordsUsed,
    wordsRemaining: Math.max(usage.wordsRemaining, 0),
    limit: usage.limit,
    plan: usage.plan,
    isSubscribed: usage.isSubscribed,
  };
}

export function buildSuperwallAttributes({
  usage,
  activeMode,
  appInfo = getSuperwallAppInfo(),
}: BuildSuperwallAttributesInput): SuperwallAttributes {
  return {
    plan: usage.plan,
    status: usage.status,
    isSubscribed: usage.isSubscribed,
    isTrial: usage.isTrial,
    trialDaysLeft: usage.trialDaysLeft ?? 0,
    wordsUsed: Math.max(usage.wordsUsed, 0),
    wordsRemaining: normalizeWordsRemaining(usage),
    activeMode,
    appEnvironment: appInfo.appEnvironment,
    appVersion: appInfo.appVersion,
  };
}

export function getSuperwallAppInfo(): AppInfo {
  const extra = Constants.expoConfig?.extra as ExpoExtra | undefined;
  return {
    appEnvironment: extra?.openWhispr?.appEnvironment ?? (__DEV__ ? 'development' : 'production'),
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  };
}

function normalizeWordsRemaining(usage: UsageInfo): number {
  if (usage.isSubscribed) return SUPERWALL_WORDS_REMAINING_SENTINEL;
  return Math.max(usage.wordsRemaining, 0);
}
