import { notchAnnouncement, notchStateFor, type NotchModel } from '../home/notchModel';

const t = (key: string) => key;
const cancel = () => undefined;
const retry = (overrides: Partial<NotchModel> = {}): NotchModel => ({
  flow: 'retry',
  startedAt: 0,
  doneText: null,
  ...overrides,
});

it('shows nothing without work', () => {
  expect(notchStateFor(null, t, cancel)).toBeNull();
  expect(notchAnnouncement(null, t)).toBe('');
});

it('says a dictation is being written up, with no cancel', () => {
  const state = notchStateFor({ flow: 'dictate', startedAt: 0, doneText: null }, t, cancel);
  expect(state).toEqual({ kind: 'busy', text: 'writingItUp' });
});

it('writes a retry up with a cancel', () => {
  const state = notchStateFor(retry(), t, cancel);
  expect(state).toEqual({ kind: 'busy', text: 'writingItUpMinute', onCancel: cancel });
  expect(notchAnnouncement(state, t)).toBe('announceWritingItUp');
});

it('shows the done text once it has arrived', () => {
  const state = notchStateFor(retry({ doneText: 'addedToHistory' }), t, cancel);
  expect(state).toEqual({ kind: 'done', text: 'addedToHistory' });
  expect(notchAnnouncement(state, t)).toBe('addedToHistory');
});

it('slides back quietly once work is cancelled or fails', () => {
  const closing = notchStateFor(retry({ closing: true }), t, cancel);
  expect(closing).toEqual({ kind: 'closing' });
  expect(notchAnnouncement(closing, t)).toBe('');
});
