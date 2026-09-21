const UNESCAPED_PIPE = /(?<!\\)\|/;
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * GFM splits a table row on every unescaped pipe, even inside code spans.
 *
 * Backslashes are deliberately left alone, which CodeQL flags as incomplete
 * escaping (js/incomplete-sanitization). Doubling them would lose content
 * instead: markdown-it, which reads these notes back, takes `\|` as a pipe
 * wherever it appears, so `\\|` round-trips as backslash-pipe and `\\\|` gains a
 * backslash on every save. cmark-gfm reads `\\|` as an escaped backslash and
 * splits the cell there, so a literal `\|` inside a code span renders
 * differently on GitHub. That's the rarer half of the trade.
 */
export function escapeTableCellPipes(markdown: string): string {
  return markdown.replace(/\|/g, "\\|");
}

/**
 * Header labels of a typed `| Item | Cost |` line, or null when the line is not
 * one. A delimiter row, a row with no text, or more than one line is not a header.
 */
export function parseTableHeaderRow(line: string): string[] | null {
  const row = line.trim();
  if (row.includes("\n") || !row.startsWith("|") || !row.endsWith("|") || row.endsWith("\\|")) {
    return null;
  }
  const labels = row
    .slice(1, -1)
    .split(UNESCAPED_PIPE)
    .map((label) => label.trim().replace(/\\\|/g, "|"));
  if (labels.every((label) => !label) || labels.every((label) => DELIMITER_CELL.test(label))) {
    return null;
  }
  return labels;
}
