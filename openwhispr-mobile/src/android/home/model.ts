import type { BubbleStatus } from '../../../modules/android-dictation/src';
import type { InsightEvent } from '../insights';
import type { Transcript } from '@/android/types';
import type { HomeKey } from './strings';
import type { LucideIconName } from '@/components/ui/SystemIcon';

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

/**
 * How far along an upload looks, 0..1. Transcription reports no progress of its own, so this
 * eases towards 90% over a time scaled to the file size, moves into the last stretch once the
 * text is being tidied, and only reaches 100% when the text has arrived.
 */
export function uploadProgress({
  elapsedMs,
  sizeBytes,
  cleaningMs,
  done,
}: {
  elapsedMs: number;
  sizeBytes?: number;
  /** Time since tidying started, or undefined while still transcribing. */
  cleaningMs?: number;
  done: boolean;
}): number {
  if (done) return 1;
  const megabytes = (sizeBytes ?? 0) / 1_000_000;
  const scaleSeconds = Math.min(90, Math.max(4, 3 + megabytes * 2));
  const transcribing = 0.9 * (1 - Math.exp(-elapsedMs / 1000 / scaleSeconds));
  if (cleaningMs === undefined) return transcribing;
  const tidying = 0.75 + 0.2 * (1 - Math.exp(-cleaningMs / 1000 / 3));
  return Math.max(transcribing, tidying);
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

/** Lucide icon on each permission's button; accessibility is Android's standing figure, never a wheelchair. */
export const PERMISSION_ICON: Record<Permission, LucideIconName> = {
  overlay: 'Layers',
  accessibility: 'PersonStanding',
  microphone: 'Mic',
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

export type HistoryGroup = {
  key: string;
  title: string;
  rows: { item: Transcript; meta: string }[];
};

const startOfDay = (time: number) => {
  const day = new Date(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/**
 * The History page's sections, newest first: Today and Yesterday (rows show the time), This
 * week (the weekday), then one per month (the date). Rows within a section keep their order.
 */
export function groupHistory(
  items: Transcript[],
  t: T,
  language: string,
  now = Date.now(),
): HistoryGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const weekStart = startOfDay(today - 6 * 86_400_000 + 3_600_000);
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const groups: HistoryGroup[] = [];
  for (const item of [...items].sort((a, b) => b.createdAt - a.createdAt)) {
    const at = item.createdAt;
    const date = new Date(at);
    const [key, title, meta] =
      at >= today
        ? ['today', t('today'), time(at)]
        : at >= yesterday
          ? ['yesterday', t('yesterday'), time(at)]
          : at >= weekStart
            ? ['week', t('thisWeek'), date.toLocaleDateString(language, { weekday: 'long' })]
            : [
                `${date.getFullYear()}-${date.getMonth()}`,
                date.toLocaleDateString(language, { month: 'long', year: 'numeric' }),
                date.toLocaleDateString(language, { day: 'numeric', month: 'short' }),
              ];
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push({ item, meta });
    else groups.push({ key, title, rows: [{ item, meta }] });
  }
  return groups;
}

/** Rows whose text (or failure) contains the search, ignoring case. */
export function matchHistory(items: Transcript[], query: string): Transcript[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    (item.status === 'failed' ? item.errorMessage || '' : item.text)
      .toLocaleLowerCase()
      .includes(needle),
  );
}
