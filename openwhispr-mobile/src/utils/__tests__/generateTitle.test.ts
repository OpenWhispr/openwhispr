import { deriveLocalTitle } from '../generateTitle';

describe('deriveLocalTitle', () => {
  it('takes the first words of the transcript', () => {
    expect(
      deriveLocalTitle('Discuss launch risks and onboarding next steps for the team today'),
    ).toBe('Discuss launch risks and onboarding next steps for');
  });

  it('strips trailing punctuation', () => {
    expect(deriveLocalTitle('Discuss launch risks.')).toBe('Discuss launch risks');
  });

  it('returns an empty string for blank input', () => {
    expect(deriveLocalTitle('   ')).toBe('');
  });

  it('caps overly long titles at the character limit', () => {
    const longWord = 'a'.repeat(150);
    expect(deriveLocalTitle(longWord).length).toBeLessThanOrEqual(100);
  });
});
