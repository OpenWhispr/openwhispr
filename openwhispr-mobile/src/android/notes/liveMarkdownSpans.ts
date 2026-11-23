/**
 * The Notes tab's own notes stay Markdown (what desktop's editor and iOS read and write), but are
 * shown as formatted text: read as rendered lines with no marks, and edited with the marks shown
 * only on the line being written. The text itself is never rewritten for display, so the caret,
 * the selection and what's saved stay exactly what was typed.
 */
export type LiveSpanKind = 'plain' | 'mark' | 'bold' | 'italic' | 'boldItalic' | 'code' | 'mention';

export type LiveSpan = { text: string; kind: LiveSpanKind; heading?: 1 | 2 | 3 };

export type NoteLineKind = 'plain' | 'heading' | 'bullet' | 'check' | 'numbered';

export type NoteLine = {
  /** Offset of the line's first character in the whole text. */
  start: number;
  /** The line as typed, marks included. */
  text: string;
  /** The block mark the line starts with (`## `, `- `, `- [ ] `, `1. `), or ''. */
  mark: string;
  kind: NoteLineKind;
  heading?: 1 | 2 | 3;
  checked?: boolean;
  /** Spans of the text after the block mark. */
  inline: LiveSpan[];
};

// A line's block mark: a heading, a checklist item (before bullets, which share `- `), a bullet,
// or a numbered item.
const BLOCK_MARK = /^(#{1,3} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

// Inline marks as CommonMark reads them in ordinary notes: `code`, ***both***, **bold** / __bold__,
// *italic* / _italic_. Underscores only count at word edges, so snake_case stays plain. A run
// can't start or end on a space, matching how `**  x**` stays literal.
// A person mention as summaries write it, `[@Josh](mention:josh%40openwhispr.com)`: shown as "@Josh"
// with the link part hidden like any other mark.
const INLINE =
  /(\[@[^\]\n]+\]\(mention:[^)\s]*\))|(`[^`\n]+`)|(\*\*\*(?=\S)[^*\n]*?\S\*\*\*)|(\*\*(?=\S)[^*\n]*?\S\*\*)|((?<![\p{L}\p{N}_])__(?=\S)[^_\n]*?\S__(?![\p{L}\p{N}_]))|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|((?<![\p{L}\p{N}_])_(?=[^\s_])[^_\n]*?[^\s_]_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])_[^\s_]_(?![\p{L}\p{N}_]))/gu;

function inlineSpans(text: string, heading: LiveSpan['heading']): LiveSpan[] {
  const out: LiveSpan[] = [];
  const push = (piece: string, kind: LiveSpanKind) => {
    if (piece) out.push(heading ? { text: piece, kind, heading } : { text: piece, kind });
  };
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const raw = match[0];
    const at = match.index ?? 0;
    push(text.slice(last, at), 'plain');
    if (match[1]) {
      const label = raw.indexOf('](');
      push('[', 'mark');
      push(raw.slice(1, label), 'mention');
      push(raw.slice(label), 'mark');
      last = at + raw.length;
      continue;
    }
    const [width, kind]: [number, LiveSpanKind] = match[2]
      ? [1, 'code']
      : match[3]
        ? [3, 'boldItalic']
        : match[4] || match[5]
          ? [2, 'bold']
          : [1, 'italic'];
    push(raw.slice(0, width), 'mark');
    push(raw.slice(width, raw.length - width), kind);
    push(raw.slice(raw.length - width), 'mark');
    last = at + raw.length;
  }
  push(text.slice(last), 'plain');
  return out;
}

/** Splits notes into lines with their block mark and inline spans. */
export function parseNoteLines(text: string): NoteLine[] {
  let start = 0;
  return text.split('\n').map((line) => {
    const mark = line.match(BLOCK_MARK)?.[0] ?? '';
    const kind: NoteLineKind = !mark
      ? 'plain'
      : mark.startsWith('#')
        ? 'heading'
        : mark.includes('[')
          ? 'check'
          : /^\d/.test(mark)
            ? 'numbered'
            : 'bullet';
    const heading = kind === 'heading' ? (Math.min(mark.length - 1, 3) as 1 | 2 | 3) : undefined;
    const parsed: NoteLine = {
      start,
      text: line,
      mark,
      kind,
      inline: inlineSpans(line.slice(mark.length), heading),
    };
    if (heading) parsed.heading = heading;
    if (kind === 'check') parsed.checked = /\[[xX]\]/.test(mark);
    start += line.length + 1;
    return parsed;
  });
}

/** Splits notes into styled spans whose texts join back to exactly `text`. */
export function liveMarkdownSpans(text: string): LiveSpan[] {
  const out: LiveSpan[] = [];
  const lines = parseNoteLines(text);
  lines.forEach((line, index) => {
    if (line.mark) {
      out.push(
        line.heading
          ? { text: line.mark, kind: 'mark', heading: line.heading }
          : { text: line.mark, kind: 'mark' },
      );
    }
    out.push(...line.inline);
    if (index < lines.length - 1) out.push({ text: '\n', kind: 'plain' });
  });
  return out;
}

/** The text with one checklist line's box ticked or cleared. */
export function toggleCheck(text: string, line: NoteLine): string {
  if (line.kind !== 'check') return text;
  const box = line.mark.indexOf('[') + 1;
  const at = line.start + box;
  return text.slice(0, at) + (line.checked ? ' ' : 'x') + text.slice(at + 1);
}

/** The index of the line holding `offset`. */
export function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < Math.min(offset, text.length); index++) {
    if (text[index] === '\n') line++;
  }
  return line;
}

/** The notes' words without Markdown marks, lines joined by spaces: for one-line previews. */
export function plainNoteText(text: string): string {
  return parseNoteLines(text)
    .map((line) =>
      line.inline
        .filter((span) => span.kind !== 'mark')
        .map((span) => span.text)
        .join('')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}
