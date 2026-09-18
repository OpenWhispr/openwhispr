const UNESCAPED_PIPE = /(?<!\\)\|/;
const DELIMITER_CELL = /^:?-+:?$/;

/** GFM splits a table row on every unescaped pipe, even inside code spans. */
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
