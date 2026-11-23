import {
  lineAt,
  liveMarkdownSpans,
  parseNoteLines,
  plainNoteText,
  toggleCheck,
  type LiveSpan,
} from '../liveMarkdownSpans';

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

describe('parseNoteLines', () => {
  const text = '## Plan\n- Call Sam\n- [ ] Book room\n- [x] Sent deck\n2. Second\nplain **bold**';
  const lines = parseNoteLines(text);

  it('reads each line kind and where it starts', () => {
    expect(lines.map((line) => [line.kind, line.start])).toEqual([
      ['heading', 0],
      ['bullet', 8],
      ['check', 19],
      ['check', 35],
      ['numbered', 51],
      ['plain', 61],
    ]);
    expect(lines[0].heading).toBe(2);
    expect([lines[2].checked, lines[3].checked]).toEqual([false, true]);
  });

  it('keeps marks out of the words a line shows', () => {
    const shown = lines[5].inline.filter((span) => span.kind !== 'mark').map((span) => span.text);
    expect(shown).toEqual(['plain ', 'bold']);
  });

  it('ticks and clears a checkbox in place', () => {
    const ticked = toggleCheck(text, lines[2]);
    expect(ticked.split('\n')[2]).toBe('- [x] Book room');
    expect(toggleCheck(ticked, parseNoteLines(ticked)[3]).split('\n')[3]).toBe('- [ ] Sent deck');
    expect(toggleCheck(text, lines[1])).toBe(text);
  });

  it('finds the caret line', () => {
    expect(lineAt(text, 0)).toBe(0);
    expect(lineAt(text, 7)).toBe(0);
    expect(lineAt(text, 8)).toBe(1);
    expect(lineAt(text, text.length)).toBe(5);
  });
});

describe('plainNoteText', () => {
  it('drops every mark for a one-line preview', () => {
    expect(plainNoteText('## Launch plan\n- Call **Sam**\n- [ ] Book _the_ room\n\n')).toBe(
      'Launch plan Call Sam Book the room',
    );
  });
});

describe('mentions in summaries', () => {
  const line = '- [ ] Follow up — [@Josh](mention:josh%40openwhispr.com) by Friday';

  it('shows a mention as its name, the link part kept as a hidden mark', () => {
    const [parsed] = parseNoteLines(line);
    const mention = parsed.inline.find((span) => span.kind === 'mention');
    expect(mention?.text).toBe('@Josh');
    expect(parsed.inline.map((span) => span.text).join('')).toBe(line.slice(parsed.mark.length));
    expect(plainNoteText(line)).toBe('Follow up — @Josh by Friday');
  });

  it('keeps the text exact for editing, so the caret and what is saved never move', () => {
    expect(
      liveMarkdownSpans(line)
        .map((span) => span.text)
        .join(''),
    ).toBe(line);
  });
});
