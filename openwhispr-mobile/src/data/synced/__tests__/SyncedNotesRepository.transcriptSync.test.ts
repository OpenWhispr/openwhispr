jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));

import { SyncedNotesRepository } from '../SyncedNotesRepository';
import { requestSync } from '@/sync/syncEngine';
import type { LocalNotesRepository } from '../../local/notesRepository';

const mockRequestSync = requestSync as jest.Mock;

const makeLocal = () =>
  ({
    replaceSegments: jest.fn(),
    updateSpeaker: jest.fn(),
    mergeSpeakers: jest.fn(),
    moveNoteToSpace: jest.fn(),
    getNotesBySpace: jest.fn(() => []),
  }) as unknown as LocalNotesRepository;

describe('SyncedNotesRepository — transcript writes are syncable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaceSegments delegates and nudges a debounced sync', () => {
    const local = makeLocal();
    new SyncedNotesRepository(local).replaceSegments(1, []);
    expect(local.replaceSegments).toHaveBeenCalledWith(1, []);
    expect(mockRequestSync).toHaveBeenCalledWith('after-write');
  });

  it('updateSpeaker delegates and nudges a debounced sync', () => {
    const local = makeLocal();
    new SyncedNotesRepository(local).updateSpeaker(5, { displayName: 'Alice' });
    expect(local.updateSpeaker).toHaveBeenCalledWith(5, { displayName: 'Alice' });
    expect(mockRequestSync).toHaveBeenCalledWith('after-write');
  });

  it('mergeSpeakers delegates and nudges a debounced sync', () => {
    const local = makeLocal();
    new SyncedNotesRepository(local).mergeSpeakers(1, 2, 3, {});
    expect(local.mergeSpeakers).toHaveBeenCalledWith(1, 2, 3, {});
    expect(mockRequestSync).toHaveBeenCalledWith('after-write');
  });
});

describe('SyncedNotesRepository — move-to-space is syncable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('moveNoteToSpace delegates to the repository and nudges a debounced sync', () => {
    const local = makeLocal();
    new SyncedNotesRepository(local).moveNoteToSpace(9, 3);
    expect(local.moveNoteToSpace).toHaveBeenCalledWith(9, 3);
    expect(mockRequestSync).toHaveBeenCalledWith('after-write');
  });

  it('getNotesBySpace reads straight through with no sync side effect', () => {
    const local = makeLocal();
    new SyncedNotesRepository(local).getNotesBySpace(3);
    expect(local.getNotesBySpace).toHaveBeenCalledWith(3);
    expect(mockRequestSync).not.toHaveBeenCalled();
  });
});
