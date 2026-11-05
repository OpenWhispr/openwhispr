import * as FileSystem from 'expo-file-system/legacy';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { notes } from '@/db/schema';
import { meetingAudioContext, meetingAudioDirectory } from '@/lib/meetingAudioStorage';

/** Compare and replace only the obsolete root path; keep timestamps and note data intact. */
export function restoreAndroidMeetingRecordingPath(
  database: typeof db,
  noteId: number,
  previousSourceFile: string,
  sourceFile: string,
): void {
  database
    .update(notes)
    .set({ sourceFile })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.noteType, 'meeting'),
        isNull(notes.deletedAt),
        eq(notes.sourceFile, previousSourceFile),
      ),
    )
    .run();
}

/** Code 43 saved a root URI while native Cloud capture used the account directory. */
export async function repairAndroidMeetingRecordingPaths(
  audio: ReturnType<typeof meetingAudioContext>,
): Promise<void> {
  const root = FileSystem.documentDirectory;
  const directory = meetingAudioDirectory(audio.namespace);
  if (!audio.namespace || !root || !directory || !audio.isCurrent()) return;
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists || !audio.isCurrent()) return;
  const files = await FileSystem.readDirectoryAsync(directory);
  for (const name of files) {
    if (!audio.isCurrent()) return;
    const noteId = Number(/^meeting-(\d+)\.wav$/.exec(name)?.[1]);
    if (!noteId) continue;
    restoreAndroidMeetingRecordingPath(db, noteId, `${root}${name}`, `${directory}${name}`);
  }
}
