import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { Note } from '@/android/shared/data';

export type MatchPlace = 'title' | 'notes' | 'summary' | 'transcript';

export type SearchHit = {
  note: Note;
  place: MatchPlace;
  /** The matching line, cut around the match; empty for a title match. */
  snippet: string;
  /** Where the match sits in `snippet`. */
  start: number;
  length: number;
};

const PLACE_RANK: Record<MatchPlace, number> = { title: 0, summary: 1, notes: 2, transcript: 3 };
const SNIPPET_LEAD = 28;
const SNIPPET_LENGTH = 90;

function flat(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The line around the first match: "…and after that the pricing call". */
export function snippetAround(
  text: string,
  query: string,
): { snippet: string; start: number; length: number } | null {
  const body = flat(text);
  const at = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET_LEAD);
  // Start on a word boundary, so the snippet never opens mid-word.
  const boundary = from === 0 ? 0 : body.indexOf(' ', from) + 1 || from;
  const begin = boundary > at ? from : boundary;
  const lead = begin > 0 ? '…' : '';
  const slice = body.slice(begin, begin + SNIPPET_LENGTH);
  const tail = begin + SNIPPET_LENGTH < body.length ? '…' : '';
  return {
    snippet: `${lead}${slice}${tail}`,
    start: lead.length + at - begin,
    length: query.length,
  };
}

/**
 * Searches titles, typed notes, AI summaries and transcripts (Figma S2), best match first:
 * a title beats a summary, then your notes, then the transcript; newer first within each.
 * `transcriptOf` is only asked for notes nothing else matched.
 */
export function searchNotes(
  notes: Note[],
  rawQuery: string,
  transcriptOf: (note: Note) => string,
): SearchHit[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const hits: SearchHit[] = [];
  for (const note of notes) {
    const title = note.title ?? '';
    if (title.toLocaleLowerCase().includes(needle)) {
      hits.push({ note, place: 'title', snippet: '', start: 0, length: 0 });
      continue;
    }
    const tries: [MatchPlace, string][] = [
      ['summary', note.enhancedContent ?? ''],
      ['notes', note.content ?? ''],
    ];
    let found: SearchHit | null = null;
    for (const [place, text] of tries) {
      const match = text ? snippetAround(text, query) : null;
      if (match) {
        found = { note, place, ...match };
        break;
      }
    }
    if (!found) {
      const transcript = transcriptOf(note);
      const match = transcript ? snippetAround(transcript, query) : null;
      if (match) found = { note, place: 'transcript', ...match };
    }
    if (found) hits.push(found);
  }
  return hits.sort(
    (left, right) =>
      PLACE_RANK[left.place] - PLACE_RANK[right.place] ||
      (right.note.updatedAt ?? '').localeCompare(left.note.updatedAt ?? ''),
  );
}

const RECENT_KEY = 'android.notes.recentSearches';
const RECENT_LIMIT = 8;

/** Recent searches on this phone (Figma S1), newest first, each removable. */
export const useRecentSearches = create<{ items: string[] }>(() => ({ items: [] }));

let loaded = false;
export function loadRecentSearches() {
  if (loaded) return;
  loaded = true;
  AsyncStorage.getItem(RECENT_KEY)
    .then((value) => {
      const items = value ? (JSON.parse(value) as unknown) : [];
      if (Array.isArray(items))
        useRecentSearches.setState({
          items: items.filter((item): item is string => typeof item === 'string'),
        });
    })
    .catch(() => undefined);
}

function save(items: string[]) {
  useRecentSearches.setState({ items });
  AsyncStorage.setItem(RECENT_KEY, JSON.stringify(items)).catch(() => undefined);
}

export function rememberSearch(query: string) {
  const value = query.trim();
  if (!value) return;
  const rest = useRecentSearches
    .getState()
    .items.filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase());
  save([value, ...rest].slice(0, RECENT_LIMIT));
}

export function forgetSearch(query: string) {
  save(useRecentSearches.getState().items.filter((item) => item !== query));
}
