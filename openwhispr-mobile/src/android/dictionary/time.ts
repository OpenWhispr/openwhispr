import { settingsT } from '../settings/strings';
import { relativeTime } from '../settings/kit';

/** "3 Nov": a word's date in the list. */
export function shortDate(ms: number, language: string): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** "2h ago" within a week, the date after that (the review card's "· 2h"). */
export function sinceLearned(ms: number, language: string): string {
  if (Date.now() - ms > WEEK) return shortDate(ms, language);
  return relativeTime(new Date(ms).toISOString(), settingsT);
}
