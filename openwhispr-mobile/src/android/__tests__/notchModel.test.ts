import { notchAnnouncement, notchStateFor, uploadRing, type NotchModel } from '../home/notchModel';

const t = (key: string, options?: Record<string, unknown>) =>
  options?.percent === undefined ? key : `${key}:${options.percent}`;
const cancel = () => undefined;
const upload = (overrides: Partial<NotchModel> = {}): NotchModel => ({
  flow: 'upload',
  startedAt: 0,
  doneText: null,
  name: 'team-sync.m4a',
  size: 500_000,
  ...overrides,
});

it('shows nothing without work', () => {
  expect(notchStateFor(null, 'transcribing', 0, t, cancel)).toBeNull();
  expect(notchAnnouncement(null, null, 'transcribing', 0, t)).toBe('');
});

it('says a dictation is being written up, with no cancel', () => {
  const state = notchStateFor(
    { flow: 'dictate', startedAt: 0, doneText: null },
    'transcribing',
    500,
    t,
    cancel,
  );
  expect(state).toEqual({ kind: 'busy', text: 'writingItUp' });
});

it('fills the upload ring with the file name and a cancel, then writes it up', () => {
  const early = notchStateFor(upload(), 'transcribing', 1000, t, cancel);
  expect(early).toMatchObject({ kind: 'busy', detail: 'team-sync.m4a', onCancel: cancel });
  expect(early?.kind === 'busy' && early.progress).toBeGreaterThan(0);
  expect(early?.kind === 'busy' && early.text).toMatch(/^uploadingPercent:\d+$/);
  // The ring is full once half the estimate has passed; then the notch moves on.
  const later = notchStateFor(upload(), 'transcribing', 600_000, t, cancel);
  expect(later).toEqual({ kind: 'busy', text: 'writingItUpMinute', onCancel: cancel });
  expect(uploadRing(upload(), 600_000)).toBe(1);
});

it('moves on to writing it up as soon as the text is being tidied', () => {
  expect(notchStateFor(upload(), 'cleaning', 100, t, cancel)).toMatchObject({
    text: 'writingItUpMinute',
  });
});

it('shows the done text once it has arrived', () => {
  expect(
    notchStateFor(upload({ doneText: 'addedToHistory' }), 'transcribing', 100, t, cancel),
  ).toEqual({ kind: 'done', text: 'addedToHistory' });
});

it('announces uploads in steps of 25 percent, not every tick', () => {
  const at = (now: number) =>
    notchAnnouncement(
      notchStateFor(upload(), 'transcribing', now, t, cancel),
      upload(),
      'transcribing',
      now,
      t,
    );
  const heard = new Set([0, 250, 500, 750, 1000, 1250, 1500, 2000].map(at));
  expect([...heard].every((text) => /^announceUploading:(0|25|50|75)$/.test(text))).toBe(true);
  expect(heard.size).toBeLessThanOrEqual(4);
  expect(
    notchAnnouncement(
      notchStateFor(upload(), 'cleaning', 100, t, cancel),
      upload(),
      'cleaning',
      100,
      t,
    ),
  ).toBe('announceWritingItUp');
});

it('slides back quietly once work is cancelled or fails', () => {
  const closing = notchStateFor(upload({ closing: true }), 'transcribing', 100, t, cancel);
  expect(closing).toEqual({ kind: 'closing' });
  expect(notchAnnouncement(closing, upload({ closing: true }), 'transcribing', 100, t)).toBe('');
});
