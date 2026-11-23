import { liveMarkdownSpans, type LiveSpan } from '../liveMarkdownSpans';

const joined = (spans: LiveSpan[]) => spans.map((span) => span.text).join('');
const styled = (text: string) =>
  liveMarkdownSpans(text)
    .filter((span) => span.kind !== 'plain')
    .map((span) => `${span.kind}:${span.text}`);

describe('liveMarkdownSpans', () => {
  it.each([
    '',
    'plain words',
    '**bold** and _italic_ and *star* and `code`',
    '## Heading\n- item\n- [ ] task\n- [x] done\n1. first\n\n',
    'unclosed **bold and _italic',
    'snake_case_name and 2*3*4',
    '***both*** __under__',
  ])('joins back to exactly what was typed: %j', (text) => {
    expect(joined(liveMarkdownSpans(text))).toBe(text);
  });

  it('styles what the format bar writes and fades its marks', () => {
    expect(styled('a **bold** b')).toEqual(['mark:**', 'bold:bold', 'mark:**']);
    expect(styled('an _italic_ word')).toEqual(['mark:_', 'italic:italic', 'mark:_']);
    expect(styled('- item')).toEqual(['mark:- ']);
    expect(styled('- [ ] task')).toEqual(['mark:- [ ] ']);
  });

  it('makes a heading line large, marks and all', () => {
    expect(liveMarkdownSpans('## Plan')).toEqual([
      { text: '## ', kind: 'mark', heading: 2 },
      { text: 'Plan', kind: 'plain', heading: 2 },
    ]);
  });

  it('reads one-letter and both-mark runs', () => {
    expect(styled('*a* _b_')).toEqual([
      'mark:*',
      'italic:a',
      'mark:*',
      'mark:_',
      'italic:b',
      'mark:_',
    ]);
    expect(styled('***x***')).toEqual(['mark:***', 'boldItalic:x', 'mark:***']);
  });

  it('leaves text that only looks like marks alone', () => {
    expect(styled('snake_case_name')).toEqual([]);
    expect(styled('** spaced ** and * spaced *')).toEqual([]);
    expect(styled('**unclosed')).toEqual([]);
    expect(styled('-not a bullet')).toEqual([]);
  });
});
