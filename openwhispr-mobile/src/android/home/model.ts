import type { BubbleStatus } from '../../../modules/android-dictation/src';
import type { InsightEvent } from '../insights';
import type { HomeKey } from './strings';

/**
 * How many lines a short label may take so it wraps only between words: a word too wide for
 * its box then shrinks instead of splitting. Chinese, Japanese and Korean break between
 * characters anyway, so they are left alone.
 */
export function wordSafeLines(text: string): number | undefined {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
    return undefined;
  return Math.max(1, text.trim().split(/\s+/).length);
}

export type Permission = 'overlay' | 'accessibility' | 'microphone';

/** Missing permissions in the order the person is asked for them. */
export function missingPermissions(status: BubbleStatus | null | undefined): Permission[] {
  if (!status) return [];
  const missing: Permission[] = [];
  if (!status.overlay) missing.push('overlay');
  if (!status.accessibility) missing.push('accessibility');
  if (!status.microphone) missing.push('microphone');
  return missing;
}

export const PERMISSION_LABEL: Record<Permission, HomeKey> = {
  overlay: 'turnOnOverlay',
  accessibility: 'turnOnAccessibility',
  microphone: 'turnOnMicrophone',
};

type T = (key: HomeKey, options?: Record<string, unknown>) => string;

/** History rows show when, never how: no provider or source tags. */
export function relativeDate(createdAt: number, t: T, now = Date.now()): string {
  const elapsed = Math.max(0, now - createdAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const then = new Date(createdAt);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (createdAt >= startOfToday) return t('hoursAgo', { count: Math.floor(minutes / 60) });
  const days = Math.round(
    (startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days <= 1) return t('yesterday');
  if (days < 7) return t('daysAgo', { count: days });
  return then.toLocaleDateString();
}

export interface HomeStats {
  words: number | undefined;
  wordsPerMinute: number | null | undefined;
  streakDays: number | undefined;
}

/**
 * Account stats come from the server's summary once sync is on; otherwise everything is
 * counted from this phone's ledger. `undefined` means not known yet and renders as a dash.
 */
export function homeStats(
  events: InsightEvent[],
  accountSummary:
    | {
        totalWords: number;
        averageWpm?: number | null;
        currentStreakDays?: number;
      }
    | undefined,
  useAccount: boolean,
  today: string,
): HomeStats {
  if (useAccount)
    return {
      words: accountSummary?.totalWords,
      wordsPerMinute: accountSummary?.averageWpm,
      streakDays: accountSummary?.currentStreakDays,
    };
  return {
    words: events.reduce((total, item) => total + item.word_count, 0),
    wordsPerMinute: averageWordsPerMinute(events),
    streakDays: currentStreakDays(
      events.map((item) => item.local_date),
      today,
    ),
  };
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Port of openwhispr-api calculateStreaks: yesterday still counts as a live streak. */
export function currentStreakDays(dates: string[], today: string): number {
  const days = [...new Set(dates)].sort();
  if (days.length === 0 || dayNumber(today) - dayNumber(days[days.length - 1]) > 1) return 0;
  let streak = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (dayNumber(days[index]) - dayNumber(days[index - 1]) !== 1) break;
    streak += 1;
  }
  return streak;
}

/** Words per minute over the dictations whose speaking time is known, as the account summary does. */
export function averageWordsPerMinute(events: InsightEvent[]): number | null {
  let words = 0;
  let duration = 0;
  for (const event of events) {
    if (!event.spoken_duration_ms || event.spoken_duration_ms <= 0) continue;
    words += event.word_count;
    duration += event.spoken_duration_ms;
  }
  return duration > 0 ? Math.round((words * 60_000) / duration) : null;
}

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
