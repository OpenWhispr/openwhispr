/** Applies a FormatBar choice to the text at the selection; returns the text and new caret. */
export function applyFormat(
  text: string,
  selection: { start: number; end: number },
  kind: 'bold' | 'italic' | 'bullet' | 'check' | 'heading',
): { text: string; caret: number } {
  const { start, end } = selection;
  if (kind === 'bold' || kind === 'italic') {
    const mark = kind === 'bold' ? '**' : '_';
    const inner = text.slice(start, end);
    const next = text.slice(0, start) + mark + inner + mark + text.slice(end);
    return { text: next, caret: end + mark.length * (inner ? 2 : 1) };
  }
  const prefix = kind === 'bullet' ? '- ' : kind === 'check' ? '- [ ] ' : '## ';
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const line = text.slice(lineStart);
  // A line holds one block mark: the same one again removes it, another replaces it, so a bullet
  // made a heading reads `## item`, never `## - item`, which no Markdown reader shows as a heading.
  const current = line.match(LINE_MARK)?.[0] ?? '';
  const replacement = current === prefix ? '' : prefix;
  const next = text.slice(0, lineStart) + replacement + line.slice(current.length);
  return {
    text: next,
    caret: Math.max(lineStart + replacement.length, start - current.length + replacement.length),
  };
}

// Block marks the format bar writes or a note may already start a line with.
const LINE_MARK = /^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;
