import * as FileSystem from 'expo-file-system/legacy';
import type { Note } from '@/data';

export interface NoteShareContentInput {
  viewMode: 'original' | 'enhanced';
  enhancedContent: string | null;
  usesSegmentTranscript: boolean;
  transcript: string;
  content: string;
}

// What the Share menu exports: the enhanced notes when that's the active view,
// otherwise what the original view shows — the formatted transcript for
// meeting notes, the note body for plain notes. Never the LLM prompt input.
export function buildNoteShareContent(input: NoteShareContentInput): string {
  if (input.viewMode === 'enhanced' && input.enhancedContent) {
    return input.enhancedContent;
  }
  return input.usesSegmentTranscript ? input.transcript : input.content;
}

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'note'
  );
}

export async function exportNote(
  note: Pick<Note, 'title' | 'content'>,
  format: 'md' | 'txt',
): Promise<void> {
  const filename = sanitizeFilename(note.title);
  const ext = format === 'md' ? '.md' : '.txt';
  const content =
    format === 'md' ? `# ${note.title}\n\n${note.content}` : `${note.title}\n\n${note.content}`;
  const uri = FileSystem.cacheDirectory + filename + ext;

  await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });

  const Sharing = await import('expo-sharing');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: format === 'md' ? 'text/markdown' : 'text/plain',
      dialogTitle: `Export ${note.title}`,
    });
  }
}
