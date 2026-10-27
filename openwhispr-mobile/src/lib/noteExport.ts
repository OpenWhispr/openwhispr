import * as FileSystem from 'expo-file-system/legacy';
import type { Note } from '@/data';
import type { NoteBodyView } from '@/lib/notes/noteBodyTabs';

export interface NoteShareContentInput {
  viewMode: NoteBodyView;
  enhancedContent: string | null;
  transcript: string;
  content: string;
}

// What the Share menu exports: exactly what the active tab shows — the generated notes, the
// formatted transcript (empty while it is still being made), or the note body. Never the LLM
// prompt input.
export function buildNoteShareContent(input: NoteShareContentInput): string {
  switch (input.viewMode) {
    case 'enhanced':
      return input.enhancedContent ?? '';
    case 'transcript':
      return input.transcript;
    case 'notes':
      return input.content;
  }
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
