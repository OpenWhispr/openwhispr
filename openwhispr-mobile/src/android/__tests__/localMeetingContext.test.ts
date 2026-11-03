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
      return jest.fn();
    },
  },
}));
jest.mock('@/data', () => ({ notesRepository: { getNoteById: () => mockNote } }));
jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
import { createLocalMeetingContext } from '../localMeetingContext';
beforeEach(() => {
  mockAuthCallbacks.clear();
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
