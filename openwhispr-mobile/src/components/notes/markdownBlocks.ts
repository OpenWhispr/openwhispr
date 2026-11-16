export type TableAlignment = 'left' | 'center' | 'right' | null;

export type MarkdownBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'bullet' | 'paragraph'; content: string }
  | { type: 'numbered'; content: string; number: number }
  | { type: 'empty' }
  | { type: 'rule' }
  | { type: 'table'; header: string[]; alignments: TableAlignment[]; rows: string[][] };

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const DELIMITER_CELL = /^:?-+:?$/;
const UNESCAPED_PIPE = /(?<!\\)\|/;

/**
 * Cells of one pipe-table row. `\|` is a literal pipe, matching how desktop
 * notes escape pipes in cells. Unlike GFM, a pipe inside a closed code span
 * does not split the cell: model answers put `a | b` in backticks unescaped.
 */
export function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (char === '\\' && row[index + 1] === '|') {
      cell += '|';
      index++;
    } else if (char === '`') {
      const close = row.indexOf('`', index + 1);
      if (close === -1) {
        cell += char;
      } else {
        cell += row.slice(index, close + 1).replace(/\\\|/g, '|');
        index = close;
      }
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseDelimiterRow(line: string, columnCount: number): TableAlignment[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (cells.length !== columnCount || !cells.every((cell) => DELIMITER_CELL.test(cell))) {
    return null;
  }
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function isTableRow(line: string): boolean {
  return line.trim() !== '' && UNESCAPED_PIPE.test(line);
}

function parseLine(line: string): MarkdownBlock {
  if (line.trim() === '') return { type: 'empty' };
  if (line.startsWith('### ')) return { type: 'h3', content: line.slice(4) };
  if (line.startsWith('## ')) return { type: 'h2', content: line.slice(3) };
  if (line.startsWith('# ')) return { type: 'h1', content: line.slice(2) };
  // Before bullets, which would otherwise swallow `* * *` and `- - -`.
  if (THEMATIC_BREAK.test(line)) return { type: 'rule' };

  const bulletMatch = line.match(/^[-*]\s+(.*)/);
  if (bulletMatch) return { type: 'bullet', content: bulletMatch[1] };

  const numberedMatch = line.match(/^(\d+)\.\s+(.*)/);
  if (numberedMatch) {
    return { type: 'numbered', content: numberedMatch[2], number: parseInt(numberedMatch[1], 10) };
  }

  return { type: 'paragraph', content: line };
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const header = isTableRow(line) ? splitTableRow(line) : null;
    const alignments =
      header && index + 1 < lines.length
        ? parseDelimiterRow(lines[index + 1], header.length)
        : null;

    if (!header || !alignments) {
      blocks.push(parseLine(line));
      index++;
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && isTableRow(lines[index])) {
      const cells = splitTableRow(lines[index]);
      rows.push(header.map((_, column) => cells[column] ?? ''));
      index++;
    }
    blocks.push({ type: 'table', header, alignments, rows });
  }

  return blocks;
}
