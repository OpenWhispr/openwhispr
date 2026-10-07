import { parseNoteTimestamp, tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';

describe('tryParseNoteTimestamp', () => {
  it('reads SQLite datetime("now") stamps as UTC', () => {
    expect(tryParseNoteTimestamp('2026-09-25 10:15:30')?.toISOString()).toBe(
      '2026-09-25T10:15:30.000Z',
    );
  });

  it('reads ISO stamps with a Z designator', () => {
    expect(tryParseNoteTimestamp('2026-09-25T10:15:30.250Z')?.toISOString()).toBe(
      '2026-09-25T10:15:30.250Z',
    );
  });

  it('keeps an explicit UTC offset instead of appending Z', () => {
    expect(tryParseNoteTimestamp('2026-09-25T10:15:30+00:00')?.toISOString()).toBe(
      '2026-09-25T10:15:30.000Z',
    );
  });

  it('applies a non-zero offset', () => {
    expect(tryParseNoteTimestamp('2026-09-25T12:15:30+02:00')?.toISOString()).toBe(
      '2026-09-25T10:15:30.000Z',
    );
  });

  it('passes Dates and epoch numbers through', () => {
    const date = new Date('2026-09-25T10:15:30Z');
    expect(tryParseNoteTimestamp(date)).toBe(date);
    expect(tryParseNoteTimestamp(date.getTime())?.getTime()).toBe(date.getTime());
  });

  it('returns null for missing or unparsable stamps', () => {
    expect(tryParseNoteTimestamp(null)).toBeNull();
    expect(tryParseNoteTimestamp(undefined)).toBeNull();
    expect(tryParseNoteTimestamp('')).toBeNull();
    expect(tryParseNoteTimestamp('not a date')).toBeNull();
  });
});

describe('parseNoteTimestamp', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('falls back to now for missing or unparsable stamps', () => {
    expect(parseNoteTimestamp(null).toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(parseNoteTimestamp('not a date').toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('parses offset stamps rather than falling back to now', () => {
    expect(parseNoteTimestamp('2026-09-25T10:15:30+00:00').toISOString()).toBe(
      '2026-09-25T10:15:30.000Z',
    );
  });
});
