import type { InsightEvent } from '../insights';
import {
  averageWordsPerMinute,
  currentStreakDays,
  homeStats,
  localDate,
  missingPermissions,
  relativeDate,
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
