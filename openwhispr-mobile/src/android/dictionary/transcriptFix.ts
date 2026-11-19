import { notesRepository } from '@/data';
import { useNotesStore } from '@/store/useNotesStore';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The misheard word as a whole word, in any case: "Sinty" but not "Sintyx". */
function wholeWord(word: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escape(word)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
}

export function countWord(text: string, word: string): number {
  if (!word.trim()) return 0;
  return [...text.matchAll(wholeWord(word))].length;
}

export function replaceWord(text: string, from: string, to: string): string {
  return text.replace(wholeWord(from), (_match, before: string) => `${before}${to}`);
}

/**
 * C10: fixes every mention of a misheard word in one note's transcript and returns how many
 * it fixed. The segments keep their ids for sync (client and remote); only the text changes.
 */
export function fixWordInTranscript(noteId: number, from: string, to: string): number {
  const segments = notesRepository.getSegments(noteId);
  let fixed = 0;
  const next = segments.map(({ id: _id, createdAt: _createdAt, ...segment }) => {
    const count = countWord(segment.text, from);
    fixed += count;
    return count > 0 ? { ...segment, text: replaceWord(segment.text, from, to) } : segment;
  });
  if (fixed === 0) return 0;
  notesRepository.replaceSegments(noteId, next);
  useNotesStore.setState((state) => ({ transcriptRevision: state.transcriptRevision + 1 }));
  return fixed;
}
