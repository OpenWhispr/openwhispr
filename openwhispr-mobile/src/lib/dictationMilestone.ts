import 'expo-sqlite/localStorage/install';
import { Platform } from 'react-native';
import { getInstallationTimeAsync } from 'expo-application';
import { logAppsFlyerEventConfirmed, subscribeAppsFlyerAttribution } from '@/lib/appsflyer';
import type { recordDictationCompleted } from '@/lib/productEvents';
import { isUsageAnalyticsAllowed } from '@/lib/usageAnalytics';
import { useConfigStore } from '@/store/useConfigStore';

// The mobile ad-measurement milestone: one AppsFlyer event the first time this
// install has dictated 200 words. It counts the same finished dictations as the
// dashboard's dictation_completed (never practice or re-transcriptions), but per
// install and only from this version on, and nothing about a dictation leaves
// the phone except the event and the values below. AppsFlyer sends it only for
// people who allowed tracking with Usage Analytics on; desktop's equivalent is
// the server's Dictated200Words.
const EVENT_NAME = 'dictated_200_words';
const WORDS_NEEDED = 200;
const STORAGE_KEY = 'openwhispr.dictation-milestone.v1';
const RECENT_CAPTURE_LIMIT = 20;
const DAY_MS = 86_400_000;

type FinishedDictation = Parameters<typeof recordDictationCompleted>[0];

interface MilestoneState {
  words: number;
  // 'sent' and 'suppressed' are final.
  status: 'counting' | 'pending' | 'sent' | 'suppressed';
  recentCaptureIds: string[];
  crossing?: {
    at: number;
    transcriptionMode: FinishedDictation['provider'];
    inputSource: 'keyboard' | 'app';
  };
}

let state: MilestoneState | null = null;
let inFlight: Promise<void> | null = null;
let flushAgain = false;
let didInit = false;

function readState(): MilestoneState {
  if (state) return state;
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    const parsed = json ? (JSON.parse(json) as MilestoneState) : null;
    state = parsed && typeof parsed.words === 'number' ? parsed : null;
  } catch (error) {
    console.warn('[dictation-milestone] read failed', error);
  }
  state ??= { words: 0, status: 'counting', recentCaptureIds: [] };
  return state;
}

// A failed write keeps the in-memory state for this session.
function writeState(next: MilestoneState): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('[dictation-milestone] write failed', error);
  }
}

function usageAnalyticsAllowed(): boolean {
  return isUsageAnalyticsAllowed(useConfigStore.getState().config);
}

function installAgeBucket(days: number): string {
  if (days <= 0) return '0';
  if (days === 1) return '1';
  if (days <= 3) return '2-3';
  if (days <= 7) return '4-7';
  if (days <= 14) return '8-14';
  return '15+';
}

async function eventValues(
  crossing: NonNullable<MilestoneState['crossing']>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {
    transcription_mode: crossing.transcriptionMode,
    input_source: crossing.inputSource,
  };
  try {
    const installedAt = (await getInstallationTimeAsync()).getTime();
    values.days_since_install_bucket = installAgeBucket(
      Math.floor((crossing.at - installedAt) / DAY_MS),
    );
  } catch {
    // Without a readable install time the age is left out, never guessed.
  }
  return values;
}

/** A finished dictation, reported beside dictation_completed. Never throws. */
export function recordDictationMilestone(dictation: FinishedDictation): void {
  try {
    const { captureId, words, context, retranscribe } = dictation;
    if (!usageAnalyticsAllowed() || context.isPractice || retranscribe || !words) return;
    const current = readState();
    if (current.status !== 'counting' || current.recentCaptureIds.includes(captureId)) return;

    const total = Math.min(WORDS_NEEDED, current.words + words);
    const recentCaptureIds = [...current.recentCaptureIds, captureId].slice(-RECENT_CAPTURE_LIMIT);
    if (total < WORDS_NEEDED) {
      writeState({ ...current, words: total, recentCaptureIds });
      return;
    }
    writeState({
      words: total,
      status: 'pending',
      recentCaptureIds,
      crossing: {
        at: Date.now(),
        transcriptionMode: dictation.provider,
        inputSource: dictation.source === 'keyboard' ? 'keyboard' : 'app',
      },
    });
    flushDictationMilestone().catch(() => undefined);
  } catch (error) {
    console.warn('[dictation-milestone] record failed', error);
  }
}

/** Sends a pending milestone; it stays pending until AppsFlyer confirms it. */
export function flushDictationMilestone(): Promise<void> {
  // A flush asked for while one runs (a crossing, an SDK-ready signal) runs once more after it.
  if (inFlight) {
    flushAgain = true;
    return inFlight;
  }
  inFlight = (async (): Promise<void> => {
    do {
      flushAgain = false;
      await sendPending();
    } while (flushAgain);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function sendPending(): Promise<void> {
  const current = readState();
  // Android has no tracking prompt yet, so nothing is sent there until it asks.
  if (current.status !== 'pending' || !current.crossing || Platform.OS !== 'ios') return;
  const delivered = await logAppsFlyerEventConfirmed(
    EVENT_NAME,
    await eventValues(current.crossing),
  );
  // A confirmed send is recorded as sent even if the user opted out meanwhile.
  if (delivered) writeState({ ...readState(), status: 'sent' });
}

/** Retries on every AppsFlyer ready signal; turning Usage Analytics off cancels an unsent milestone. */
export function initDictationMilestone(): void {
  if (didInit) return;
  didInit = true;
  subscribeAppsFlyerAttribution((): void => {
    flushDictationMilestone().catch(() => undefined);
  });
  useConfigStore.subscribe((): void => {
    const { config } = useConfigStore.getState();
    if (config === null || usageAnalyticsAllowed()) return;
    const current = readState();
    if (current.status === 'pending') writeState({ ...current, status: 'suppressed' });
  });
  flushDictationMilestone().catch(() => undefined);
}
