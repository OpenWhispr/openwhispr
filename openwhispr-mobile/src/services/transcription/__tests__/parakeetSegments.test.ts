import { tokenTimingsToWhisperSegments } from '../parakeetSegments';
import type { ParakeetTokenTiming } from '../../../../modules/parakeet-asr/src';

const timing = (token: string, startTime: number, endTime: number): ParakeetTokenTiming => ({
  token,
  startTime,
  endTime,
  confidence: 0.9,
});

describe('tokenTimingsToWhisperSegments', () => {
  it('groups subword tokens into words at ▁ boundaries', () => {
    const segments = tokenTimingsToWhisperSegments([
      timing('▁hel', 0.1, 0.2),
      timing('lo', 0.2, 0.3),
      timing('▁world', 0.4, 0.6),
    ]);
    expect(segments).toEqual([
      { text: 'hel' + 'lo', t0: 10, t1: 30 },
      { text: 'world', t0: 40, t1: 60 },
    ]);
  });

  it('attaches punctuation-only tokens to the preceding word', () => {
    const segments = tokenTimingsToWhisperSegments([
      timing('▁hello', 0, 0.3),
      timing(',', 0.3, 0.3),
      timing('▁there', 0.4, 0.7),
      timing('.', 0.7, 0.75),
    ]);
    expect(segments.map((s) => s.text)).toEqual(['hello,', 'there.']);
  });

  it('converts seconds to centiseconds with rounding', () => {
    const segments = tokenTimingsToWhisperSegments([timing('▁word', 1.234, 2.678)]);
    expect(segments).toEqual([{ text: 'word', t0: 123, t1: 268 }]);
  });

  it('clamps zero/negative-duration tokens so t1 never precedes t0', () => {
    const segments = tokenTimingsToWhisperSegments([timing('▁blip', 0.504, 0.5)]);
    expect(segments[0].t1).toBeGreaterThanOrEqual(segments[0].t0);
  });

  it('treats leading-space tokens as word boundaries too', () => {
    const segments = tokenTimingsToWhisperSegments([
      timing(' hi', 0, 0.1),
      timing(' yo', 0.2, 0.3),
    ]);
    expect(segments.map((s) => s.text)).toEqual(['hi', 'yo']);
  });

  it('drops empty/marker-only words and returns [] for empty input', () => {
    expect(tokenTimingsToWhisperSegments([])).toEqual([]);
    expect(tokenTimingsToWhisperSegments([timing('▁', 0, 0.1)])).toEqual([]);
  });

  it('starts a word even when the first token carries no boundary marker', () => {
    const segments = tokenTimingsToWhisperSegments([timing('hel', 0, 0.1), timing('lo', 0.1, 0.2)]);
    expect(segments).toEqual([{ text: 'hello', t0: 0, t1: 20 }]);
  });
});
