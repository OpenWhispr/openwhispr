import { formatLibraryTime } from '../libraryTime';

it('formats equivalent SQLite UTC and explicit-offset timestamps identically', () => {
  expect(formatLibraryTime('2026-10-16 12:00:00', 'de')).toBe(
    formatLibraryTime('2026-10-16T14:00:00+02:00', 'de'),
  );
});
it('returns no broken label for missing or invalid timestamps', () => {
  expect(formatLibraryTime('', 'de')).toBe('');
  expect(formatLibraryTime('broken', 'de')).toBe('');
  expect(formatLibraryTime(NaN, 'de')).toBe('');
});
it('uses the requested app language without requiring Intl.RelativeTimeFormat', () => {
  const relative = Intl.RelativeTimeFormat;
  Object.defineProperty(Intl, 'RelativeTimeFormat', { value: undefined, configurable: true });
  try {
    const timestamp = '2026-10-16T12:00:00Z';
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    expect(formatLibraryTime(timestamp, 'ar')).toBe(
      new Date(timestamp).toLocaleString('ar', options),
    );
    expect(formatLibraryTime(timestamp, 'de')).toContain('Okt.');
    expect(formatLibraryTime(timestamp, 'ar')).not.toBe(formatLibraryTime(timestamp, 'en'));
  } finally {
    Object.defineProperty(Intl, 'RelativeTimeFormat', { value: relative, configurable: true });
  }
});
