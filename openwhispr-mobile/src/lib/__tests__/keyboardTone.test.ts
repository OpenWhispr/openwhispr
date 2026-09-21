import { KEYBOARD_TONES, isToneApplicable } from '@/lib/keyboardTone';

describe('keyboardTone', () => {
  it('lists the five tones with default first', () => {
    expect(KEYBOARD_TONES.map((tone) => tone.value)).toEqual([
      'default',
      'formal',
      'casual',
      'very_casual',
      'excited',
    ]);
  });

  it('is applicable only in cloud mode with cleanup on', () => {
    expect(isToneApplicable('cloud', true)).toBe(true);
    expect(isToneApplicable('cloud', undefined)).toBe(true);
    expect(isToneApplicable('cloud', false)).toBe(false);
    expect(isToneApplicable('private', true)).toBe(false);
  });
});
