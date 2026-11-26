import type { Transcript } from '@/android/types';
import type { InsightEvent } from '../insights';
import {
  averageWordsPerMinute,
  currentStreakDays,
  groupHistory,
  homeStats,
  localDate,
  matchHistory,
  missingPermissions,
  PERMISSION_ICON,
  relativeDate,
  uploadProgress,
  wordSafeLines,
} from '../home/model';

const event = (
  local_date: string,
  word_count: number,
  spoken_duration_ms: number | null,
): InsightEvent => ({
  event_id: `${local_date}-${word_count}-${spoken_duration_ms}`,
  occurred_at: `${local_date}T10:00:00.000Z`,
  local_date,
  word_count,
  spoken_duration_ms,
  mode: 'local',
  provider: 'local',
  model: null,
  counter_version: 2,
});

describe('currentStreakDays (port of the API calculateStreaks)', () => {
  it('counts a run of days that ends today', () => {
    expect(currentStreakDays(['2026-11-14', '2026-11-15', '2026-11-16'], '2026-11-16')).toBe(3);
  });
  it('still counts a run that ended yesterday', () => {
    expect(currentStreakDays(['2026-11-14', '2026-11-15'], '2026-11-16')).toBe(2);
  });
  it('drops a run that ended two days ago', () => {
    expect(currentStreakDays(['2026-11-13', '2026-11-14'], '2026-11-16')).toBe(0);
  });
  it('ignores repeats and order, and stops at a gap', () => {
    expect(
      currentStreakDays(['2026-11-16', '2026-11-10', '2026-11-15', '2026-11-16'], '2026-11-16'),
    ).toBe(2);
  });
  it('crosses a month boundary', () => {
    expect(currentStreakDays(['2026-10-31', '2026-11-01'], '2026-11-01')).toBe(2);
  });
  it('is zero with no dictations', () => {
    expect(currentStreakDays([], '2026-11-16')).toBe(0);
  });
});

describe('averageWordsPerMinute', () => {
  it('weights by speaking time and skips dictations without one', () => {
    // 120 words over 60 s and 30 words over 30 s → 150 words / 1.5 min = 100.
    expect(
      averageWordsPerMinute([
        event('2026-11-16', 120, 60_000),
        event('2026-11-16', 30, 30_000),
        event('2026-11-16', 500, null),
      ]),
    ).toBe(100);
  });
  it('is null when no dictation was timed', () => {
    expect(averageWordsPerMinute([event('2026-11-16', 10, null)])).toBeNull();
  });
});

describe('homeStats', () => {
  const events = [event('2026-11-15', 40, 20_000), event('2026-11-16', 20, 10_000)];
  it('counts this phone when account stats are off', () => {
    expect(homeStats(events, undefined, false, '2026-11-16')).toEqual({
      words: 60,
      wordsPerMinute: 120,
      streakDays: 2,
    });
  });
  it('shows the account summary when account stats are on', () => {
    expect(
      homeStats(
        events,
        { totalWords: 1284, averageWpm: 142, currentStreakDays: 5 },
        true,
        '2026-11-16',
      ),
    ).toEqual({ words: 1284, wordsPerMinute: 142, streakDays: 5 });
  });
  it('leaves account stats unknown until a summary arrives', () => {
    expect(homeStats(events, undefined, true, '2026-11-16')).toEqual({
      words: undefined,
      wordsPerMinute: undefined,
      streakDays: undefined,
    });
  });
});

describe('missingPermissions', () => {
  const all = {
    overlay: true,
    accessibility: true,
    microphone: true,
    enabled: true,
    batteryExempt: true,
  };
  it('asks for nothing when everything is granted', () => {
    expect(missingPermissions(all)).toEqual([]);
  });
  it('asks for overlay, then accessibility, then the microphone', () => {
    expect(
      missingPermissions({ ...all, overlay: false, accessibility: false, microphone: false }),
    ).toEqual(['overlay', 'accessibility', 'microphone']);
    expect(missingPermissions({ ...all, accessibility: false })).toEqual(['accessibility']);
  });
  it('does not treat a missing native module as a missing permission', () => {
    expect(missingPermissions(null)).toEqual([]);
  });
});

describe('relativeDate', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options?.count === undefined ? key : `${key}:${options.count}`;
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  it.each([
    [new Date(2026, 10, 16, 14, 59, 40).getTime(), 'justNow'],
    [new Date(2026, 10, 16, 14, 55).getTime(), 'minutesAgo:5'],
    [new Date(2026, 10, 16, 9, 0).getTime(), 'hoursAgo:6'],
    [new Date(2026, 10, 15, 23, 0).getTime(), 'yesterday'],
    [new Date(2026, 10, 13, 12, 0).getTime(), 'daysAgo:3'],
  ])('labels %s as %s', (createdAt, label) => {
    expect(relativeDate(createdAt, t, now)).toBe(label);
  });
});

it('formats the local calendar date', () => {
  expect(localDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
});

it('lets a label wrap only between words, except in Chinese, Japanese and Korean', () => {
  expect(wordSafeLines('gesprochene Wörter')).toBe(2);
  expect(wordSafeLines('words per minute')).toBe(3);
  expect(wordSafeLines('Wörterbuch')).toBe(1);
  expect(wordSafeLines('1分あたりの単語')).toBeUndefined();
  expect(wordSafeLines('連續天數')).toBeUndefined();
});

describe('uploadProgress', () => {
  it('starts at zero and rises gradually, never reaching the end on its own', () => {
    const at = (elapsedMs: number) =>
      uploadProgress({ elapsedMs, sizeBytes: 500_000, done: false });
    expect(at(0)).toBe(0);
    expect(at(1000)).toBeGreaterThan(0.1);
    expect(at(1000)).toBeLessThan(0.3);
    expect(at(3000)).toBeGreaterThan(at(1000));
    expect(at(600_000)).toBeLessThanOrEqual(0.9);
  });
  it('moves more slowly for a bigger file', () => {
    const small = uploadProgress({ elapsedMs: 5000, sizeBytes: 200_000, done: false });
    const big = uploadProgress({ elapsedMs: 5000, sizeBytes: 20_000_000, done: false });
    expect(big).toBeLessThan(small);
  });
  it('enters the last stretch while tidying and never goes backwards', () => {
    const before = uploadProgress({ elapsedMs: 60_000, sizeBytes: 100_000, done: false });
    const tidying = uploadProgress({
      elapsedMs: 60_000,
      sizeBytes: 100_000,
      cleaningMs: 0,
      done: false,
    });
    expect(tidying).toBeGreaterThanOrEqual(0.75);
    expect(tidying).toBeGreaterThanOrEqual(before);
    expect(
      uploadProgress({ elapsedMs: 60_000, sizeBytes: 100_000, cleaningMs: 600_000, done: false }),
    ).toBeLessThan(1);
  });
  it('is full once the text has arrived', () => {
    expect(uploadProgress({ elapsedMs: 10, done: true })).toBe(1);
  });
});

it('has every Home string in every language', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { homeTranslations } = require('../home/translations');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { homeEnglish } = jest.requireActual('../home/strings.ts') as {
    homeEnglish: Record<string, string>;
  };
  for (const [language, strings] of Object.entries(
    homeTranslations as Record<string, Record<string, string>>,
  ))
    expect([language, Object.keys(homeEnglish).filter((key) => !(key in strings))]).toEqual([
      language,
      [],
    ]);
});

describe('PERMISSION_ICON', () => {
  it('shows Android’s standing figure for Accessibility, never a wheelchair', () => {
    expect(PERMISSION_ICON.accessibility).toBe('PersonStanding');
  });
});

describe('History page', () => {
  const now = new Date(2026, 10, 19, 12, 0).getTime();
  const row = (id: string, at: Date, text = id, extra: Partial<Transcript> = {}): Transcript => ({
    id,
    text,
    createdAt: at.getTime(),
    updatedAt: at.getTime(),
    provider: 'openai' as Transcript['provider'],
    ...extra,
  });
  const t = (key: string) => key;
  const items = [
    row('older', new Date(2026, 9, 2, 9, 0)),
    row('today', new Date(2026, 10, 19, 10, 42)),
    row('week', new Date(2026, 10, 15, 8, 0)),
    row('yesterday', new Date(2026, 10, 18, 17, 5)),
    row('today2', new Date(2026, 10, 19, 11, 0)),
  ];

  it('groups newest first: Today, Yesterday, This week, then by month', () => {
    const groups = groupHistory(items, t as never, 'en-US', now);
    expect(groups.map((group) => group.key)).toEqual(['today', 'yesterday', 'week', '2026-9']);
    expect(groups[0].rows.map((r) => r.item.id)).toEqual(['today2', 'today']);
    expect(groups[3].title).toBe('October 2026');
    expect(groups[2].rows[0].meta).toBe('Sunday');
  });

  it('searches the text, or the failure for a row that wasn’t sent, ignoring case', () => {
    const rows = [
      row('a', new Date(now), 'Tomorrow at 4 works'),
      row('b', new Date(now), '', { status: 'failed', errorMessage: 'Network lost' }),
    ];
    expect(matchHistory(rows, ' TOMORROW ').map((r) => r.id)).toEqual(['a']);
    expect(matchHistory(rows, 'network').map((r) => r.id)).toEqual(['b']);
    expect(matchHistory(rows, '')).toHaveLength(2);
  });
});
