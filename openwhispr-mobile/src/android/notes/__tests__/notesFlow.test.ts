const mockPush = jest.fn();
const mockDeleteNote = jest.fn();
const mockCreateNote = jest.fn(() => ({ id: 42 }));
const mockShowToast = jest.fn();

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('@/lib/utils', () => ({ safeHaptics: jest.fn() }));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: {
    getState: () => ({ deleteNote: mockDeleteNote, createNote: mockCreateNote }),
  },
}));
jest.mock('../../settings/kit', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));
jest.mock('../../strings', () => {
  const i18n = { addResourceBundle: jest.fn(), t: (key: string) => key };
  return { __esModule: true, default: i18n };
});

import { startMeeting, startNote, startUpload } from '../start';
import { deleteNotesWithUndo, usePendingDeletes } from '../pendingDeletes';

type ToastAction = { onPress: () => void; onClose: () => void };
const lastAction = (): ToastAction => mockShowToast.mock.calls.at(-1)[2] as ToastAction;

beforeEach(() => {
  jest.clearAllMocks();
  usePendingDeletes.setState({ ids: [], restored: [] });
});

describe('starting something new', () => {
  it('files a written note in the folder it was started from', () => {
    startNote(5);
    expect(mockCreateNote).toHaveBeenCalledWith(undefined, undefined, 5);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/[id]',
      params: { id: '42', fresh: '1' },
    });
  });

  it.each([
    [{ folderId: 9, spaceId: 3 }, { folderId: '9' }],
    [{ spaceId: 3 }, { spaceId: '3' }],
    [{}, {}],
  ])('records into %j as %j', (place, params) => {
    startMeeting(place);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/(tabs)/(notes)/meeting-record', params });
  });

  it('carries the calendar event to the recorder', () => {
    startMeeting({ folderId: 2, eventId: 7 });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/meeting-record',
      params: { folderId: '2', eventId: '7' },
    });
  });

  it('uploads into the folder being viewed', () => {
    startUpload({ folderId: 4 });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/(notes)/import-audio',
      params: { folderId: '4' },
    });
  });
});

describe('delete with Undo', () => {
  it('hides the notes at once and deletes only when the toast closes', () => {
    deleteNotesWithUndo([1, 2]);
    expect(usePendingDeletes.getState().ids).toEqual([1, 2]);
    expect(mockDeleteNote).not.toHaveBeenCalled();
    expect(mockShowToast.mock.calls[0][3]).toEqual({ durationMs: 6000, aboveTabBar: true });
    lastAction().onClose();
    expect(mockDeleteNote.mock.calls).toEqual([[1], [2]]);
    expect(usePendingDeletes.getState().ids).toEqual([]);
  });

  it('Undo brings the notes back and never deletes them', () => {
    deleteNotesWithUndo([3], 'Pricing call');
    const action = lastAction();
    action.onPress();
    action.onClose();
    expect(mockDeleteNote).not.toHaveBeenCalled();
    expect(usePendingDeletes.getState()).toEqual({ ids: [], restored: [3] });
  });
});
