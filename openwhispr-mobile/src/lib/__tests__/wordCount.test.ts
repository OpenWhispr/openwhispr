import { WORD_COUNTER_VERSION, countSpokenWords } from '../wordCount';

// The same fixture is asserted against the desktop's countSpokenWords and the
// API's countAnalyticsWords, so a Chinese, Japanese or Korean dictation counts
// the same on every client and on the server.
const SHARED_WORD_COUNT_FIXTURE: [string, number][] = [
  ['Send the report to Dana by Friday.', 7],
  ['我今天很高兴', 4],
  ['東京タワーに行きました。', 5],
  ['안녕하세요 반갑습니다', 2],
  ['OpenWhispr 很好用', 3],
  ['   ', 0],
];

describe('countSpokenWords', () => {
  it('counts the word fixture the desktop app and the API share', () => {
    expect(SHARED_WORD_COUNT_FIXTURE.map(([text]) => [text, countSpokenWords(text)])).toEqual(
      SHARED_WORD_COUNT_FIXTURE,
    );
  });

  it("is the analytics ledger's counter version", () => {
    expect(WORD_COUNTER_VERSION).toBe(2);
  });

  describe('on an engine without Intl.Segmenter, as on Hermes', () => {
    const segmenter = Intl.Segmenter;
    beforeEach(() => {
      delete (Intl as { Segmenter?: unknown }).Segmenter;
    });
    afterEach(() => {
      (Intl as { Segmenter?: unknown }).Segmenter = segmenter;
    });

    it('still counts speech written with spaces between words', () => {
      expect(countSpokenWords('Send the report to Dana by Friday.')).toBe(7);
      expect(countSpokenWords('   ')).toBe(0);
    });

    it('leaves Chinese, Japanese and Korean uncounted rather than miscounted', () => {
      expect(countSpokenWords('我今天很高兴')).toBeNull();
      expect(countSpokenWords('東京タワーに行きました。')).toBeNull();
      expect(countSpokenWords('안녕하세요 반갑습니다')).toBeNull();
      expect(countSpokenWords('OpenWhispr 很好用')).toBeNull();
    });
  });
});
