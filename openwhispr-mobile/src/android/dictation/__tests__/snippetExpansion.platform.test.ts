import { expandSnippets as expand } from '@/android/dictation/snippets';

describe('Android snippet expansion', () => {
  it.each(['.', '!', '?', '。', '！', '？'])('does not repeat a %s sentence mark', (mark) => {
    const snippets = [{ trigger: 'sign off', replacement: 'Thanks' + mark }];
    const expected = 'Thanks' + mark;
    expect(expand('sign off' + mark + ' sign off' + mark, snippets)).toBe(
      expected + ' ' + expected,
    );
  });
  it('does not remove unrelated or mismatched punctuation', () => {
    expect(expand('signoff? Done!!', [{ trigger: 'signoff', replacement: 'Thank you.' }])).toBe(
      'Thank you.? Done!!',
    );
    expect(expand('Done!!', [])).toBe('Done!!');
  });
  it('retains the array-reference cache contract', () => {
    const snippets = [{ trigger: 'sig', replacement: 'First.' }];
    expect(expand('sig.', snippets)).toBe('First.');
    snippets[0].replacement = 'Mutated.';
    expect(expand('sig.', snippets)).toBe('First.');
    expect(expand('sig.', [...snippets])).toBe('Mutated.');
  });
});
