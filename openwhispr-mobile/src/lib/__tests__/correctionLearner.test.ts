import { extractCorrections } from '../correctionLearner';

describe('correction learning from note edits', () => {
  it('does not learn unrelated words when a note body is replaced', () => {
    const before =
      'uh order 12 blue folders, not 20. Nia can collect them after 3 pm only if Omar confirms. Do not email the draft to customers. The budget is 45 dollars. I still need to decide whether to book the room.';
    const after =
      'um can Bea send the revised mockup today? I do not know whether the customer accepted the offer. We could discuss it tomorrow, but I have not booked a meeting.';

    expect(extractCorrections(before, after, [])).toEqual([]);
  });

  it('does not treat a new paragraph as a spelling correction', () => {
    expect(
      extractCorrections(
        'Please send the annual report before Friday.',
        'Bring the blue folders to the office after lunch.',
        [],
      ),
    ).toEqual([]);
  });

  it('still learns a corrected name within a retained sentence', () => {
    expect(
      extractCorrections('Please ask Maren about this.', 'Please ask Marin about this.', []),
    ).toEqual(['Marin']);
  });

  it('still learns several corrections in an otherwise retained note', () => {
    expect(
      extractCorrections(
        'Please ask Maren about the report and send the draft to Jullian today.',
        'Please ask Marin about the report and send the draft to Julian today.',
        [],
      ),
    ).toEqual(['Marin', 'Julian']);
  });

  it('still supports a single-word dictation correction', () => {
    expect(extractCorrections('OpenWisper', 'OpenWhispr', [])).toEqual(['OpenWhispr']);
  });

  it('does not learn unfinished words from successive autosaves while typing', () => {
    expect(extractCorrections('Please ask Mar', 'Please ask Maren', [])).toEqual([]);
    expect(extractCorrections('Please ask Maren', 'Please ask Mare', [])).toEqual([]);
  });

  it('does not count duplicate common words as retained context', () => {
    expect(extractCorrections('the the the cat', 'the cut other words', [])).toEqual([]);
  });

  it('keeps dictionary deduplication and case-only edits unchanged', () => {
    expect(extractCorrections('Please ask Maren.', 'Please ask Marin.', ['marin'])).toEqual([]);
    expect(extractCorrections('ask marin now', 'Ask Marin now', [])).toEqual([]);
  });
});
