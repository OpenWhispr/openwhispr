import { parseMarkdownBlocks, splitTableRow } from '../markdownBlocks';

describe('splitTableRow', () => {
  it('drops the outer pipes and trims each cell', () => {
    expect(splitTableRow('| Item |  Cost |')).toEqual(['Item', 'Cost']);
  });

  it('splits rows written without outer pipes', () => {
    expect(splitTableRow('Item | Cost')).toEqual(['Item', 'Cost']);
  });

  it('keeps empty cells in place', () => {
    expect(splitTableRow('| a |  | c |')).toEqual(['a', '', 'c']);
  });

  it('reads an escaped pipe as part of the cell, as the desktop serializer writes it', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('does not split on a pipe inside a code span', () => {
    expect(splitTableRow('| `a | b` | c |')).toEqual(['`a | b`', 'c']);
  });

  it('treats an unclosed backtick as a literal so the row still splits', () => {
    expect(splitTableRow('| `a | b |')).toEqual(['`a', 'b']);
  });

  it('keeps a trailing escaped pipe as content', () => {
    expect(splitTableRow('| a | b \\|')).toEqual(['a', 'b |']);
  });
});

describe('parseMarkdownBlocks', () => {
  it('parses a table with its header, alignments, and rows', () => {
    const blocks = parseMarkdownBlocks(
      ['| Name | Qty | Price |', '| :--- | :-: | ---: |', '| Apple | 2 | $1 |'].join('\n'),
    );
    expect(blocks).toEqual([
      {
        type: 'table',
        header: ['Name', 'Qty', 'Price'],
        alignments: ['left', 'center', 'right'],
        rows: [['Apple', '2', '$1']],
      },
    ]);
  });

  it('leaves alignment unset when the delimiter has no colons', () => {
    const [block] = parseMarkdownBlocks('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(block).toMatchObject({ type: 'table', alignments: [null, null] });
  });

  it('parses a table written without outer pipes', () => {
    const [block] = parseMarkdownBlocks('a | b\n--- | ---\n1 | 2');
    expect(block).toMatchObject({ type: 'table', header: ['a', 'b'], rows: [['1', '2']] });
  });

  it('parses a header-only table', () => {
    const blocks = parseMarkdownBlocks('| a | b |\n| - | - |');
    expect(blocks).toEqual([
      { type: 'table', header: ['a', 'b'], alignments: [null, null], rows: [] },
    ]);
  });

  it('pads short rows and drops cells beyond the header', () => {
    const [block] = parseMarkdownBlocks('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
    expect(block).toMatchObject({
      rows: [
        ['1', ''],
        ['1', '2'],
      ],
    });
  });

  it('ends the table at a blank line or a line without a pipe', () => {
    const blocks = parseMarkdownBlocks(
      ['| a |', '| - |', '| 1 |', 'After the table', '', '| x |'].join('\n'),
    );
    expect(blocks.map((block) => block.type)).toEqual(['table', 'paragraph', 'empty', 'paragraph']);
    expect(blocks[0]).toMatchObject({ rows: [['1']] });
  });

  it('keeps surrounding blocks around a table', () => {
    const blocks = parseMarkdownBlocks(
      ['## Budget', '| a | b |', '|---|---|', '| 1 | 2 |', '- next step'].join('\n'),
    );
    expect(blocks.map((block) => block.type)).toEqual(['h2', 'table', 'bullet']);
  });

  it('does not treat a pipe line without a delimiter row as a table', () => {
    expect(parseMarkdownBlocks('Pick A | B\nthen continue')).toEqual([
      { type: 'paragraph', content: 'Pick A | B' },
      { type: 'paragraph', content: 'then continue' },
    ]);
  });

  it('does not treat a delimiter whose column count differs from the header as a table', () => {
    const blocks = parseMarkdownBlocks('| a | b |\n| --- |');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('reads a plain line followed by --- as text and a rule, not a table', () => {
    const blocks = parseMarkdownBlocks('Title\n---');
    expect(blocks).toEqual([{ type: 'paragraph', content: 'Title' }, { type: 'rule' }]);
  });

  it('parses thematic breaks instead of printing them', () => {
    const blocks = parseMarkdownBlocks(['---', '***', '___', '* * *', '- - -'].join('\n'));
    expect(blocks).toEqual(Array.from({ length: 5 }, () => ({ type: 'rule' })));
  });

  it('keeps the existing line blocks', () => {
    expect(
      parseMarkdownBlocks(
        ['# One', '## Two', '### Three', '- dash', '* star', '3. third', ''].join('\n'),
      ),
    ).toEqual([
      { type: 'h1', content: 'One' },
      { type: 'h2', content: 'Two' },
      { type: 'h3', content: 'Three' },
      { type: 'bullet', content: 'dash' },
      { type: 'bullet', content: 'star' },
      { type: 'numbered', content: 'third', number: 3 },
      { type: 'empty' },
    ]);
  });
});
