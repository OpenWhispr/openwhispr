import { cleanGeneratedTitle, deriveLocalTitle } from '../generateTitle';

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

describe('cleanGeneratedTitle', () => {
  it('removes Markdown bold around the title', () => {
    expect(cleanGeneratedTitle('**Talent and Culture Drive Success**')).toBe(
      'Talent and Culture Drive Success',
    );
  });

  it('removes other Markdown wrappers and heading marks', () => {
    expect(cleanGeneratedTitle('__Roadmap Review__')).toBe('Roadmap Review');
    expect(cleanGeneratedTitle('*Budget Notes*')).toBe('Budget Notes');
    expect(cleanGeneratedTitle('# Weekly Sync')).toBe('Weekly Sync');
    expect(cleanGeneratedTitle('`Release Plan`')).toBe('Release Plan');
  });

  it('removes quotes, also around Markdown', () => {
    expect(cleanGeneratedTitle('"Quarterly Planning"')).toBe('Quarterly Planning');
    expect(cleanGeneratedTitle('"**Hiring Plan**"')).toBe('Hiring Plan');
  });

  it('removes bold inside the title', () => {
    expect(cleanGeneratedTitle('Q3 **Budget** Review')).toBe('Q3 Budget Review');
  });

  it('keeps symbols that are part of the words', () => {
    expect(cleanGeneratedTitle('C++ Code Review')).toBe('C++ Code Review');
    expect(cleanGeneratedTitle('2 * 3 Pricing Tiers')).toBe('2 * 3 Pricing Tiers');
  });

  it('returns an empty string when only Markdown is left', () => {
    expect(cleanGeneratedTitle('****')).toBe('');
    expect(cleanGeneratedTitle('   ')).toBe('');
  });
});
