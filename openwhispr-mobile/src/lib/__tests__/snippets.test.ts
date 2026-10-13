import { expandSnippets, getDictionaryHintWords, type Snippet } from '../snippets';

describe('expandSnippets', () => {
  it('replaces a trigger with its replacement', () => {
    const snippets: Snippet[] = [{ trigger: 'linkedin', replacement: 'LinkedIn' }];
    expect(expandSnippets('check my linkedin profile', snippets)).toBe('check my LinkedIn profile');
  });

  it('matches triggers case-insensitively', () => {
    const snippets: Snippet[] = [{ trigger: 'linkedin', replacement: 'LinkedIn' }];
    expect(expandSnippets('Check my LinkedIn and LINKEDIN', snippets)).toBe(
      'Check my LinkedIn and LinkedIn',
    );
  });

  it('does not match inside a word', () => {
    const snippets: Snippet[] = [{ trigger: 'ask', replacement: 'ASK' }];
    // "task" and "basket" contain "ask" but must not be touched.
    expect(expandSnippets('the task in my basket, ask me', snippets)).toBe(
      'the task in my basket, ASK me',
    );
  });

  it('respects punctuation and whitespace boundaries', () => {
    const snippets: Snippet[] = [{ trigger: 'eg', replacement: 'for example' }];
    expect(expandSnippets('(eg) here, eg. there', snippets)).toBe(
      '(for example) here, for example. there',
    );
  });

  it('prefers the longest trigger when one is a substring phrase of another', () => {
    const snippets: Snippet[] = [
      { trigger: 'ask', replacement: 'ASK' },
      { trigger: 'investor ask', replacement: 'the ask we make to investors' },
    ];
    expect(expandSnippets('our investor ask is big', snippets)).toBe(
      'our the ask we make to investors is big',
    );
  });

  it('expands multiple distinct triggers in one pass', () => {
    const snippets: Snippet[] = [
      { trigger: 'eg', replacement: 'for example' },
      { trigger: 'ie', replacement: 'that is' },
    ];
    expect(expandSnippets('eg this, ie that', snippets)).toBe('for example this, that is that');
  });

  it('treats regex-special characters in a trigger literally', () => {
    const snippets: Snippet[] = [{ trigger: 'c++', replacement: 'C plus plus' }];
    expect(expandSnippets('I love c++ today', snippets)).toBe('I love C plus plus today');
  });

  it('returns the text unchanged when there are no snippets', () => {
    expect(expandSnippets('nothing to do here', [])).toBe('nothing to do here');
  });

  it('returns empty text unchanged', () => {
    const snippets: Snippet[] = [{ trigger: 'eg', replacement: 'for example' }];
    expect(expandSnippets('', snippets)).toBe('');
  });

  it('ignores snippets with blank triggers', () => {
    const snippets: Snippet[] = [{ trigger: '   ', replacement: 'nope' }];
    expect(expandSnippets('leave eg alone', snippets)).toBe('leave eg alone');
  });
});

describe('getDictionaryHintWords', () => {
  it('returns the custom dictionary unchanged when there are no snippets', () => {
    expect(getDictionaryHintWords({ customDictionary: ['Acme', 'Vercel'], snippets: [] })).toEqual([
      'Acme',
      'Vercel',
    ]);
  });

  it('appends snippet triggers to the custom dictionary', () => {
    const snippets: Snippet[] = [
      { trigger: 'linkedin', replacement: 'LinkedIn' },
      { trigger: 'eg', replacement: 'for example' },
    ];
    expect(getDictionaryHintWords({ customDictionary: ['Acme'], snippets })).toEqual([
      'Acme',
      'linkedin',
      'eg',
    ]);
  });
});
