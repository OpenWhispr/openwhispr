jest.mock('@/data', () => ({
  notesRepository: {
    getSyncState: jest.fn(),
    setSyncState: jest.fn(),
    getFolders: jest.fn(),
    applyRemoteNote: jest.fn(),
  },
}));
jest.mock('@/data/remote/notesApi', () => ({
  fetchNotes: jest.fn(),
}));

import { pullNotes } from '../pullNotes';
import { notesRepository } from '@/data';
import { fetchNotes } from '@/data/remote/notesApi';

const mockRepo = notesRepository as jest.Mocked<typeof notesRepository>;
const mockFetchNotes = fetchNotes as jest.MockedFunction<typeof fetchNotes>;

function makeNote(index: number, updatedAt: string) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    client_note_id: null,
    title: `Note ${index}`,
    content: 'body',
    enhanced_content: null,
    enhancement_prompt: null,
    note_type: 'personal',
    source_file: null,
    audio_duration_seconds: null,
    folder_id: null,
    participants: null,
    calendar_event_id: null,
    transcript: null,
    deleted_at: null,
    updated_at: updatedAt,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.getFolders.mockReturnValue([]);
});

test('pages through full pages using the composite cursor', async () => {
  mockRepo.getSyncState.mockReturnValue('2026-07-01T00:00:00.000Z');
  const fullPage = Array.from({ length: 200 }, (_, i) => makeNote(i, '2026-07-02T00:00:00.000Z'));
  const lastPage = [makeNote(200, '2026-07-03T00:00:00.000Z')];
  mockFetchNotes.mockResolvedValueOnce({ notes: fullPage }).mockResolvedValueOnce({
    notes: lastPage,
  });

  await pullNotes();

  expect(mockFetchNotes).toHaveBeenCalledTimes(2);
  expect(mockFetchNotes).toHaveBeenNthCalledWith(1, {
    since: '2026-07-01T00:00:00.000Z',
    sinceId: undefined,
    limit: 200,
  });
  expect(mockFetchNotes).toHaveBeenNthCalledWith(2, {
    since: '2026-07-02T00:00:00.000Z',
    sinceId: fullPage[199].id,
    limit: 200,
  });
  expect(mockRepo.applyRemoteNote).toHaveBeenCalledTimes(201);
  expect(mockRepo.setSyncState).toHaveBeenCalledWith(
    'notes.last_sync_at',
    '2026-07-03T00:00:00.000Z',
  );
});

test('first sync crawls from the epoch instead of a single snapshot page', async () => {
  mockRepo.getSyncState.mockReturnValue(null);
  mockFetchNotes.mockResolvedValue({ notes: [makeNote(0, '2026-07-02T00:00:00.000Z')] });

  await pullNotes();

  expect(mockFetchNotes).toHaveBeenCalledTimes(1);
  expect(mockFetchNotes).toHaveBeenCalledWith({
    since: '1970-01-01T00:00:00.000Z',
    sinceId: undefined,
    limit: 200,
  });
});

test('an explicit hasMore=false on a full page stops without an extra request', async () => {
  mockRepo.getSyncState.mockReturnValue('2026-07-01T00:00:00.000Z');
  const fullPage = Array.from({ length: 200 }, (_, i) => makeNote(i, '2026-07-02T00:00:00.000Z'));
  mockFetchNotes.mockResolvedValue({ notes: fullPage, hasMore: false });

  await pullNotes();

  expect(mockFetchNotes).toHaveBeenCalledTimes(1);
});
