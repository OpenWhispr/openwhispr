import { render, type RenderResult } from '@testing-library/react-native';
import { MarkdownRenderer } from '../MarkdownRenderer';

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));

type Node = ReturnType<RenderResult['getByText']>;

// getByText returns the innermost span; alignment and selection live on the
// cell's own Text around it.
function cellText(span: Node): Node {
  let node = span.parent;
  while (node && node.type !== 'Text') node = node.parent;
  if (!node) throw new Error('span has no enclosing cell Text');
  return node;
}

const TABLE = [
  'Compared options:',
  '',
  '| Option | Cost | Notes |',
  '| --- | ---: | --- |',
  '| **Plan A** | $10 | fast \\| cheap |',
  '| Plan B | $25 |',
  '',
  '---',
  'Done.',
].join('\n');

describe('MarkdownRenderer tables', () => {
  it('renders every cell, with inline formatting and escaped pipes', () => {
    const { getByTestId, getByText } = render(<MarkdownRenderer content={TABLE} />);

    expect(getByTestId('markdown-table')).toBeOnTheScreen();
    for (const cell of [
      'Option',
      'Cost',
      'Notes',
      'Plan A',
      '$10',
      'fast | cheap',
      'Plan B',
      '$25',
    ]) {
      expect(getByText(cell)).toBeOnTheScreen();
    }
    expect(getByText('Plan A')).toHaveStyle({ fontWeight: '600' });
    expect(cellText(getByText('$10'))).toHaveStyle({ textAlign: 'right' });
    expect(cellText(getByText('Plan B'))).toHaveStyle({ textAlign: 'auto' });
  });

  it('never prints the pipe syntax or the delimiter row', () => {
    const { queryByText, getByTestId, getByText } = render(<MarkdownRenderer content={TABLE} />);

    expect(queryByText(/\| ---|---/)).toBeNull();
    expect(queryByText(/^\|/)).toBeNull();
    expect(getByTestId('markdown-rule')).toBeOnTheScreen();
    expect(getByText('Done.')).toBeOnTheScreen();
  });

  // A horizontal ScrollView defaults to flexGrow: 1, which stretched the table to
  // the full height of the note chat sheet.
  it('sizes the table to its rows instead of filling the parent', () => {
    const { getByTestId } = render(<MarkdownRenderer content={TABLE} />);
    expect(getByTestId('markdown-table')).toHaveStyle({ flexGrow: 0 });
  });

  it('keeps cells selectable when the renderer is', () => {
    const { getByText } = render(<MarkdownRenderer content={TABLE} selectable />);
    expect(cellText(getByText('$25')).props.selectable).toBe(true);
  });
});
