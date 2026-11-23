/**
 * The Notes tab's own notes stay Markdown (what desktop's editor and iOS read and write), but are
 * shown styled as they're typed: bold reads bold, italics slant, headings grow, and the marks
 * that make them (`**`, `_`, `## `, `- `, `- [ ] `) fade back. The text is never changed, so the
 * caret, the selection and what's saved stay exactly what was typed.
 */
export type LiveSpanKind = 'plain' | 'mark' | 'bold' | 'italic' | 'boldItalic' | 'code';

export type LiveSpan = { text: string; kind: LiveSpanKind; heading?: 1 | 2 | 3 };

// A line's block mark: a heading, a checklist item (before bullets, which share `- `), a bullet,
// or a numbered item.
const BLOCK_MARK = /^(#{1,3} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

// Inline marks as CommonMark reads them in ordinary notes: `code`, ***both***, **bold** / __bold__,
// *italic* / _italic_. Underscores only count at word edges, so snake_case stays plain. A run
// can't start or end on a space, matching how `**  x**` stays literal.
const INLINE =
  /(`[^`\n]+`)|(\*\*\*(?=\S)[^*\n]*?\S\*\*\*)|(\*\*(?=\S)[^*\n]*?\S\*\*)|((?<![\p{L}\p{N}_])__(?=\S)[^_\n]*?\S__(?![\p{L}\p{N}_]))|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|((?<![\p{L}\p{N}_])_(?=[^\s_])[^_\n]*?[^\s_]_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])_[^\s_]_(?![\p{L}\p{N}_]))/gu;

function inlineSpans(text: string, heading: LiveSpan['heading'], out: LiveSpan[]): void {
  const push = (piece: string, kind: LiveSpanKind) => {
    if (piece) out.push(heading ? { text: piece, kind, heading } : { text: piece, kind });
  };
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const raw = match[0];
    const at = match.index ?? 0;
    push(text.slice(last, at), 'plain');
    const [width, kind]: [number, LiveSpanKind] = match[1]
      ? [1, 'code']
      : match[2]
        ? [3, 'boldItalic']
        : match[3] || match[4]
          ? [2, 'bold']
          : [1, 'italic'];
    push(raw.slice(0, width), 'mark');
    push(raw.slice(width, raw.length - width), kind);
    push(raw.slice(raw.length - width), 'mark');
    last = at + raw.length;
  }
  push(text.slice(last), 'plain');
}

/** Splits notes into styled spans whose texts join back to exactly `text`. */
export function liveMarkdownSpans(text: string): LiveSpan[] {
  const out: LiveSpan[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const block = line.match(BLOCK_MARK)?.[0] ?? '';
    const heading = block.startsWith('#')
      ? (Math.min(block.length - 1, 3) as 1 | 2 | 3)
      : undefined;
    if (block)
      out.push(heading ? { text: block, kind: 'mark', heading } : { text: block, kind: 'mark' });
    inlineSpans(line.slice(block.length), heading, out);
    if (index < lines.length - 1) out.push({ text: '\n', kind: 'plain' });
  });
  return out;
}
