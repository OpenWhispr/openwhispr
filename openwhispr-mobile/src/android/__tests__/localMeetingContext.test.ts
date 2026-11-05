let mockIdentity: { user: { id: string } | null; sessionCookie: string | null; isGuest?: boolean } =
  { user: { id: 'a' }, sessionCookie: 'cookie' };
let mockMode = 'private';
let mockNote = {
  id: 7,
  isPrivate: 1,
  noteType: 'meeting',
  deletedAt: null as string | null,
  clientNoteId: 'a7',
  createdAt: 'original',
  ownerUserId: 'a',
  sourceFile: 'file:///meeting-7.wav',
};
const mockAuthCallbacks = new Set<() => void>();
const mockModeCallbacks = new Set<(state: { activeMode: string }) => void>();
const mockReadNote = jest.fn(() => mockNote);
const mockAccountChanged = () => {
  mockAuthCallbacks.forEach((callback) => callback());
};
let mockModeChanged: (state: { activeMode: string }) => void;
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => mockIdentity,
    subscribe: (callback: () => void) => {
      mockAuthCallbacks.add(callback);
      return () => mockAuthCallbacks.delete(callback);
    },
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: {
    getState: () => ({ activeMode: mockMode }),
    subscribe: (callback: typeof mockModeChanged) => {
      mockModeChanged = callback;
      mockModeCallbacks.add(callback);
      return () => mockModeCallbacks.delete(callback);
    },
  },
}));
jest.mock('@/data', () => ({ notesRepository: { getNoteById: () => mockReadNote() } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
import { createLocalMeetingContext } from '../localMeetingContext';
import { createCloudMeetingContext } from '../cloudMeetingContext';
beforeEach(() => {
  mockAuthCallbacks.clear();
  mockModeCallbacks.clear();
  mockReadNote.mockReset().mockImplementation(() => mockNote);
  mockIdentity = { user: { id: 'a' }, sessionCookie: 'cookie' };
  mockMode = 'private';
  mockNote = {
    id: 7,
    isPrivate: 1,
    noteType: 'meeting',
    deletedAt: null,
    clientNoteId: 'a7',
    createdAt: 'original',
    ownerUserId: 'a',
    sourceFile: 'file:///meeting-7.wav',
  };
});
it('allows marking the same account recording retryable after a mode switch, but blocks processing', () => {
  const context = createLocalMeetingContext(7);
  mockMode = 'cloud';
  mockModeChanged({ activeMode: mockMode });
  expect(context.signal.aborted).toBe(true);
  expect(context.ownsNote()).toBe(false);
  expect(context.ownsSavedNote()).toBe(true);
  context.dispose();
  expect(context.ownsSavedNote()).toBe(false);
});
it('never grants saved-note writes after account A to B to A, privacy change or deletion', () => {
  const context = createLocalMeetingContext(7);
  mockIdentity = { user: { id: 'b' }, sessionCookie: 'other' };
  mockAccountChanged();
  mockIdentity = { user: { id: 'a' }, sessionCookie: 'cookie' };
  mockAccountChanged();
  expect(context.ownsSavedNote()).toBe(false);
  context.dispose();
  const second = createLocalMeetingContext(7);
  mockNote.isPrivate = 0;
  expect(second.ownsSavedNote()).toBe(false);
  mockNote.isPrivate = 1;
  mockNote.deletedAt = 'deleted';
  expect(second.ownsSavedNote()).toBe(false);
  second.dispose();
});

it.each(['clientNoteId', 'createdAt', 'ownerUserId', 'sourceFile', 'deletedAt'] as const)(
  'does not recover a deleted or replaced saved note (%s)',
  (field) => {
    const context = createLocalMeetingContext(7);
    mockIdentity = { user: { id: 'b' }, sessionCookie: 'b-cookie' };
    mockAccountChanged();
    context.dispose();
    const recover = jest.fn();
    context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', recover);
    mockNote[field] = 'changed';
    mockIdentity = { user: { id: 'a' }, sessionCookie: 'new-a-cookie' };
    mockAccountChanged();
    expect(recover).not.toHaveBeenCalled();
  },
);
it('allows only status recovery with a refreshed owner session, never old processing', () => {
  const context = createLocalMeetingContext(7);
  mockIdentity = { user: { id: 'b' }, sessionCookie: 'b-cookie' };
  mockAccountChanged();
  context.dispose();
  let retryable = false;
  context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', () => {
    retryable = true;
  });
  expect(retryable).toBe(false);
  mockIdentity = { user: { id: 'a' }, sessionCookie: 'new-a-cookie' };
  mockAccountChanged();
  expect(retryable).toBe(true);
  expect(context.ownsSavedNote()).toBe(false);
  expect(() => context.checkpoint()).toThrow('cancelled');
});

it('does not recover after the note becomes non-private', () => {
  const context = createLocalMeetingContext(7);
  mockIdentity = { user: { id: 'b' }, sessionCookie: 'other' };
  mockAccountChanged();
  context.dispose();
  let recovered = false;
  context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', () => {
    recovered = true;
  });
  mockNote.isPrivate = 0;
  mockIdentity = { user: { id: 'a' }, sessionCookie: 'new' };
  mockAccountChanged();
  expect(recovered).toBe(false);
  expect(mockAuthCallbacks.size).toBe(0);
});
it('keeps a guest recovery bound to its original local session', () => {
  mockIdentity = { user: null, sessionCookie: 'guest-cookie', isGuest: true };
  const context = createLocalMeetingContext(7);
  mockIdentity = { user: { id: 'b' }, sessionCookie: 'other', isGuest: false };
  mockAccountChanged();
  context.dispose();
  let recoveries = 0;
  context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', () => {
    recoveries += 1;
  });
  mockIdentity = { user: null, sessionCookie: null, isGuest: false };
  mockAccountChanged();
  expect(recoveries).toBe(0);
  mockIdentity = { user: null, sessionCookie: 'guest-cookie', isGuest: true };
  mockAccountChanged();
  mockAccountChanged();
  expect(recoveries).toBe(1);
  expect(mockAuthCallbacks.size).toBe(0);
});

it('keeps public-note recovery out of the unchanged Local context', () => {
  mockNote.isPrivate = 0;
  const context = createLocalMeetingContext(7);
  const recover = jest.fn();
  context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', recover);
  expect(recover).not.toHaveBeenCalled();
  context.dispose();
  expect(mockAuthCallbacks.size).toBe(0);
});

it('recovers a public note after legitimate sync metadata changes on account return', () => {
  mockNote.isPrivate = 0;
  mockNote.ownerUserId = null as unknown as string;
  mockNote.createdAt = '2026-11-02 10:00:00';
  const context = createCloudMeetingContext(7);
  mockIdentity = { user: { id: 'b' }, sessionCookie: 'b-cookie' };
  mockAccountChanged();
  context.dispose();
  const recover = jest.fn();
  context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', recover);
  mockNote.createdAt = '2026-11-02T10:00:00.000Z';
  mockNote.ownerUserId = 'a';
  mockIdentity = { user: { id: 'a' }, sessionCookie: 'new-cookie' };
  mockAccountChanged();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(context.ownsSavedNote()).toBe(false);
});

it.each(['clientNoteId', 'ownerUserId', 'sourceFile', 'isPrivate'] as const)(
  'does not recover a public note whose stable identity changed (%s)',
  (field) => {
    mockNote.isPrivate = 0;
    const context = createCloudMeetingContext(7);
    mockIdentity = { user: { id: 'b' }, sessionCookie: 'other' };
    mockAccountChanged();
    context.dispose();
    const recover = jest.fn();
    context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', recover);
    if (field === 'isPrivate') mockNote.isPrivate = 1;
    else mockNote[field] = 'unrelated';
    mockIdentity = { user: { id: 'a' }, sessionCookie: 'new-session' };
    mockAccountChanged();
    expect(recover).not.toHaveBeenCalled();
  },
);

it.each(['private', 'public-without-client-id'] as const)(
  'keeps exact creation identity when recovering %s through the Cloud context',
  (kind) => {
    if (kind === 'public-without-client-id') {
      mockNote.isPrivate = 0;
      mockNote.clientNoteId = '';
    }
    const context = createCloudMeetingContext(7);
    mockIdentity = { user: { id: 'b' }, sessionCookie: 'other' };
    mockAccountChanged();
    context.dispose();
    const recover = jest.fn();
    context.recoverInterruptedNoteWhenOwnerReturns('file:///meeting-7.wav', recover);
    mockNote.createdAt = 'replacement';
    mockIdentity = { user: { id: 'a' }, sessionCookie: 'new-session' };
    mockAccountChanged();
    expect(recover).not.toHaveBeenCalled();
    expect(mockAuthCallbacks.size).toBe(0);
  },
);

it.each([1, 2])('does not retain subscriptions when note read %i fails', (failedRead) => {
  mockNote.isPrivate = 0;
  for (let read = 1; read < failedRead; read += 1) mockReadNote.mockReturnValueOnce(mockNote);
  mockReadNote.mockImplementationOnce(() => {
    throw new Error('Repository read failed');
  });
  expect(() => createCloudMeetingContext(7)).toThrow('Repository read failed');
  expect(mockAuthCallbacks.size).toBe(0);
  expect(mockModeCallbacks.size).toBe(0);
});
