import {
  defaultNoteBodyView,
  getNoteBodyTabLabel,
  getNoteBodyTabs,
  resolveNoteBodyView,
  type NoteBodyTabInput,
} from '@/lib/notes/noteBodyTabs';

const tabInput = (overrides: Partial<NoteBodyTabInput> = {}): NoteBodyTabInput => ({
  usesSegmentTranscript: false,
  transcriptPending: false,
  contentIsTranscript: false,
  hasEnhanced: false,
  ...overrides,
});

describe('getNoteBodyTabs', () => {
  it('offers Transcript and My notes on a transcript note before notes are generated', () => {
    expect(getNoteBodyTabs(tabInput({ usesSegmentTranscript: true }))).toEqual([
      'transcript',
      'notes',
    ]);
  });

  it('offers Enhanced and My notes once notes are generated, on any note', () => {
    expect(getNoteBodyTabs(tabInput({ usesSegmentTranscript: true, hasEnhanced: true }))).toEqual([
      'enhanced',
      'notes',
    ]);
    expect(getNoteBodyTabs(tabInput({ hasEnhanced: true }))).toEqual(['enhanced', 'notes']);
  });

  it('offers only My notes on a plain note without generated notes', () => {
    expect(getNoteBodyTabs(tabInput())).toEqual(['notes']);
  });

  it('keeps a Transcript tab for a transcript still in progress or failed, beside My notes', () => {
    expect(getNoteBodyTabs(tabInput({ transcriptPending: true }))).toEqual(['transcript', 'notes']);
    expect(getNoteBodyTabs(tabInput({ transcriptPending: true, hasEnhanced: true }))).toEqual([
      'enhanced',
      'transcript',
      'notes',
    ]);
  });

  it('never shows an upload body beside its transcript', () => {
    const upload = { contentIsTranscript: true };
    expect(getNoteBodyTabs(tabInput({ ...upload, usesSegmentTranscript: true }))).toEqual([
      'transcript',
    ]);
    expect(
      getNoteBodyTabs(tabInput({ ...upload, usesSegmentTranscript: true, hasEnhanced: true })),
    ).toEqual(['enhanced', 'transcript']);
    expect(getNoteBodyTabs(tabInput({ ...upload, transcriptPending: true }))).toEqual([
      'transcript',
    ]);
  });

  it('shows an upload without segments as its editable body', () => {
    expect(getNoteBodyTabs(tabInput({ contentIsTranscript: true }))).toEqual(['notes']);
    expect(getNoteBodyTabs(tabInput({ contentIsTranscript: true, hasEnhanced: true }))).toEqual([
      'enhanced',
      'notes',
    ]);
  });
});

describe('getNoteBodyTabLabel', () => {
  it('labels the tabs', () => {
    const input = { contentIsTranscript: false };
    expect(getNoteBodyTabLabel('enhanced', input)).toBe('Enhanced');
    expect(getNoteBodyTabLabel('transcript', input)).toBe('Transcript');
    expect(getNoteBodyTabLabel('notes', input)).toBe('My notes');
  });

  it("calls an upload's body its transcript", () => {
    expect(getNoteBodyTabLabel('notes', { contentIsTranscript: true })).toBe('Transcript');
  });
});

describe('resolveNoteBodyView', () => {
  const meeting = tabInput({ usesSegmentTranscript: true });
  const generated = tabInput({ usesSegmentTranscript: true, hasEnhanced: true });

  it('keeps the requested view while its tab exists', () => {
    expect(resolveNoteBodyView('transcript', meeting)).toBe('transcript');
    expect(resolveNoteBodyView('notes', generated)).toBe('notes');
  });

  it('moves from Transcript to Enhanced when generated notes arrive', () => {
    expect(resolveNoteBodyView('transcript', generated)).toBe('enhanced');
  });

  it('falls back to the first tab when the requested one is gone', () => {
    expect(resolveNoteBodyView('enhanced', meeting)).toBe('transcript');
    expect(resolveNoteBodyView('enhanced', tabInput())).toBe('notes');
  });
});

describe('defaultNoteBodyView', () => {
  it('opens generated notes when they exist', () => {
    expect(defaultNoteBodyView({ isAudioTranscript: true, hasEnhanced: true })).toBe('enhanced');
    expect(defaultNoteBodyView({ isAudioTranscript: false, hasEnhanced: true })).toBe('enhanced');
  });

  it('opens the transcript on an audio note, even before its segments exist', () => {
    expect(defaultNoteBodyView({ isAudioTranscript: true, hasEnhanced: false })).toBe('transcript');
  });

  it('opens My notes on a plain note', () => {
    expect(defaultNoteBodyView({ isAudioTranscript: false, hasEnhanced: false })).toBe('notes');
  });
});
