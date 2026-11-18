import { expandSnippets as iosExpand } from '../snippets';
import { expandSnippets as androidExpand } from '../snippets.android';

describe.each([
  { platform: 'ios', expand: iosExpand },
  { platform: 'android', expand: androidExpand },
])('$platform snippet expansion', ({ platform, expand }) => {
  it.each(['.', '!', '?', '。', '！', '？'])('preserves repeated %s sentence marks', (mark) => {
    const snippets = [{ trigger: 'sign off', replacement: 'Thanks' + mark }];
    const expected = 'Thanks' + mark + (platform === 'ios' ? mark : '');
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
    expect(expand('sig.', snippets)).toBe(platform === 'ios' ? 'First..' : 'First.');
    snippets[0].replacement = 'Mutated.';
    expect(expand('sig.', snippets)).toBe(platform === 'ios' ? 'First..' : 'First.');
    expect(expand('sig.', [...snippets])).toBe(platform === 'ios' ? 'Mutated..' : 'Mutated.');
  });
});
