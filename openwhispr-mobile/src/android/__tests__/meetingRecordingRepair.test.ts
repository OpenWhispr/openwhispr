import * as FileSystem from 'expo-file-system/legacy';
import { eq } from 'drizzle-orm';
import { notes, transcriptSegments } from '@/db/schema';
import { createMemoryRepository } from '@/data/local/__tests__/testDb';
import { repairAndroidMeetingRecordingPaths } from '../meetingRecordingRepair';

let mockDatabase: ReturnType<typeof createMemoryRepository>['db'];
jest.mock('@/db', () => ({
  get db() {
    return mockDatabase;
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  readDirectoryAsync: jest.fn(),
}));
const audio = { namespace: 'account-a', key: 'account-data:1', isCurrent: () => true };
beforeEach(() => {
  jest.clearAllMocks();
});
it('repairs the exact old root path while preserving note content, timestamps and transcript rows', async () => {
  const { repo, db } = createMemoryRepository();
  mockDatabase = db;
  const note = repo.createNote('Keep title', 'Keep notes');
  db.update(notes)
    .set({
      noteType: 'meeting',
      sourceFile: `file:///documents/meeting-${note.id}.wav`,
      transcript: 'Keep transcript',
    })
    .where(eq(notes.id, note.id))
    .run();
  db.insert(transcriptSegments)
    .values({ noteId: note.id, startMs: 240000, endMs: 250000, text: 'Keep final section' })
    .run();
  const before = repo.getNoteById(note.id);
  const segments = db.select().from(transcriptSegments).all();
  jest.mocked(FileSystem.readDirectoryAsync).mockResolvedValueOnce([`meeting-${note.id}.wav`]);
  await repairAndroidMeetingRecordingPaths(audio);
  expect(repo.getNoteById(note.id)).toEqual({
    ...before,
    sourceFile: `file:///documents/account-audio/account-a/meeting-${note.id}.wav`,
  });
  expect(db.select().from(transcriptSegments).all()).toEqual(segments);
});
it.each([
  'https://example.com/audio.wav',
  'file:///documents/account-audio/other/meeting-1.wav',
  null,
])('does not replace another source path: %s', async (sourceFile) => {
  const { repo, db } = createMemoryRepository();
  mockDatabase = db;
  const note = repo.createNote('Keep', '');
  db.update(notes).set({ noteType: 'meeting', sourceFile }).where(eq(notes.id, note.id)).run();
  jest.mocked(FileSystem.readDirectoryAsync).mockResolvedValueOnce([`meeting-${note.id}.wav`]);
  await repairAndroidMeetingRecordingPaths(audio);
  expect(repo.getNoteById(note.id)?.sourceFile).toBe(sourceFile);
});
it('does not write after an account revision changes during file enumeration', async () => {
  const { repo, db } = createMemoryRepository();
  mockDatabase = db;
  const note = repo.createNote('Keep', '');
  const sourceFile = `file:///documents/meeting-${note.id}.wav`;
  db.update(notes).set({ noteType: 'meeting', sourceFile }).where(eq(notes.id, note.id)).run();
  let current = true;
  jest.mocked(FileSystem.readDirectoryAsync).mockImplementationOnce(async () => {
    current = false;
    return [`meeting-${note.id}.wav`];
  });
  await repairAndroidMeetingRecordingPaths({ ...audio, isCurrent: () => current });
  expect(repo.getNoteById(note.id)?.sourceFile).toBe(sourceFile);
});

it.each(['deleted', 'personal', 'missing-file'] as const)(
  'does not repair %s recordings',
  async (kind) => {
    const { repo, db } = createMemoryRepository();
    mockDatabase = db;
    const note = repo.createNote('Keep', '');
    const sourceFile = `file:///documents/meeting-${note.id}.wav`;
    db.update(notes)
      .set({
        sourceFile,
        noteType: kind === 'personal' ? 'personal' : 'meeting',
        deletedAt: kind === 'deleted' ? '2026-11-02' : null,
      })
      .where(eq(notes.id, note.id))
      .run();
    jest
      .mocked(FileSystem.readDirectoryAsync)
      .mockResolvedValueOnce(kind === 'missing-file' ? [] : [`meeting-${note.id}.wav`]);
    await repairAndroidMeetingRecordingPaths(audio);
    expect(db.select().from(notes).get()?.sourceFile).toBe(sourceFile);
  },
);
