import {
  expandSnippets,
  resolveSnippetVariables,
  getDictionaryHintTiers,
  splitLlmDictionary,
  type Snippet,
} from '../snippets';

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

describe('getDictionaryHintTiers', () => {
  const noShared = { space: [], workspace: [] };

  it('returns the custom dictionary unchanged when there are no snippets', () => {
    expect(getDictionaryHintTiers(['Acme', 'Vercel'], [], noShared, true)).toEqual([
      ['Acme', 'Vercel'],
      [],
      [],
    ]);
  });

  it('appends snippet triggers to the custom dictionary only when asked to', () => {
    const snippets: Snippet[] = [
      { trigger: 'linkedin', replacement: 'LinkedIn' },
      { trigger: 'eg', replacement: 'for example' },
    ];
    expect(getDictionaryHintTiers(['Acme'], snippets, noShared, true)[0]).toEqual([
      'Acme',
      'linkedin',
      'eg',
    ]);
    expect(getDictionaryHintTiers(['Acme'], snippets, noShared, false)[0]).toEqual(['Acme']);
  });

  it('drops shared words already in a higher tier, case-insensitively', () => {
    const snippets: Snippet[] = [{ trigger: 'sig', replacement: 'Best, Chad' }];
    expect(
      getDictionaryHintTiers(
        ['OpenWhispr'],
        snippets,
        { space: ['openwhispr', 'Gizmo', 'SIG'], workspace: ['gizmo', 'Acme', 'acme'] },
        true,
      ),
    ).toEqual([['OpenWhispr', 'sig'], ['Gizmo'], ['Acme']]);
  });

  it('drops a shared word that is a personal word in another Unicode form', () => {
    // Personal "Café" is NFC; the shared copies are NFD and padded.
    expect(
      getDictionaryHintTiers(
        ['Café'],
        [],
        { space: ['Café'], workspace: [' café ', 'Acme'] },
        false,
      ),
    ).toEqual([['Café'], [], ['Acme']]);
  });
});

describe('splitLlmDictionary', () => {
  it('keeps every personal word and caps shared ones at 200 words, space first', () => {
    const workspace = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const { personal, shared } = splitLlmDictionary([['Piha'], ['Space'], workspace]);
    expect(personal).toEqual(['Piha']);
    expect(shared).toEqual(['Space', ...workspace.slice(0, 199)]);
  });

  it('stops at the first shared word past 2,000 characters', () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(48)}`,
    );
    const { shared } = splitLlmDictionary([[], [], [...long, 'short']]);
    expect(shared).toEqual(long);
    expect(shared.join('').length).toBe(2000);
    expect(splitLlmDictionary([[], [], ['y'.repeat(2001), 'short']]).shared).toEqual([]);
  });
});

describe('snippet variables', () => {
  const context = { now: new Date(2026, 10, 18, 9, 5), locale: 'en-US' };

  it('fills date, time, datetime and locale like desktop', () => {
    expect(
      resolveSnippetVariables('{{date}} | {{time}} | {{datetime}} | {{locale}}', context),
    ).toBe('11/18/2026 | 9:05 AM | 11/18/2026, 9:05 AM | en-US');
    expect(resolveSnippetVariables('{{date}}', { ...context, locale: 'de' })).toBe('18.11.2026');
  });

  it('leaves unknown, misspelled and prototype placeholders as typed', () => {
    const literal = '{{clipboard}} {{Date}} {{ date }} {{constructor}} {{__proto__}} {date}';
    expect(resolveSnippetVariables(literal, context)).toBe(literal);
  });

  it("fills only a snippet's saved text, never the rest of the dictation", () => {
    const snippets: Snippet[] = [{ trigger: 'stamp', replacement: 'Logged {{date}} at {{time}}' }];
    expect(expandSnippets('stamp, then put {{date}} in the template', snippets, context)).toBe(
      'Logged 11/18/2026 at 9:05 AM, then put {{date}} in the template',
    );
    expect(expandSnippets('put {{date}} in the template', snippets, context)).toBe(
      'put {{date}} in the template',
    );
  });

  it('keeps the placeholders when the runtime cannot format dates', () => {
    const spy = jest.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
      throw new RangeError('no Intl');
    });
    try {
      expect(resolveSnippetVariables('Logged {{date}}', context)).toBe('Logged {{date}}');
    } finally {
      spy.mockRestore();
    }
  });
});
