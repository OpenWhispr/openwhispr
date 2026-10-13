// A fence opens a code block on a line of its own: up to three spaces, then
// three or more backticks or tildes. A backtick fence's info string can't
// hold a backtick; with one, the line is plain paragraph text.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)/;

// An HTML comment that opens a line is a block of its own: it runs past
// blank lines, to the first line holding `-->`.
const COMMENT_BLOCK_START = /^ {0,3}<!--/;
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

// Fenced code blocks and comment blocks become blank lines; the text after a
// comment block's `-->` stays. An unclosed fence runs to the end of the
// text, as GitHub renders it. An unclosed comment hides nothing: it could
// otherwise hide real mentions after it.
function withoutCodeAndCommentBlocks(text: string): string {
  const lastClose = text.lastIndexOf(COMMENT_CLOSE);
  const lines: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const start = lineStart;
    lineStart += line.length + 1;
    if (inComment) {
      const close = line.indexOf(COMMENT_CLOSE);
      inComment = close === -1;
      lines.push(inComment ? "" : line.slice(close + COMMENT_CLOSE.length));
      continue;
    }
    const match = FENCE.exec(line);
    if (fence) {
      // Closed by the same character, at least as long, and nothing after it.
      if (
        match &&
        match[1][0] === fence[0] &&
        match[1].length >= fence.length &&
        !match[2].trim()
      ) {
        fence = null;
      }
      lines.push("");
      continue;
    }
    if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
      fence = match[1];
      lines.push("");
      continue;
    }
    const comment = COMMENT_BLOCK_START.exec(line);
    if (comment && lastClose >= start + comment[0].length) {
      const close = line.indexOf(COMMENT_CLOSE, comment[0].length);
      inComment = close === -1;
      lines.push(inComment ? "" : line.slice(close + COMMENT_CLOSE.length));
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// A code span is a whole run of backticks closed by a run of the same
// length; part of a longer run, or a run whose first backtick is escaped by
// a backslash (an odd number of them), never opens one. An unmatched
// backtick is plain text. The `(?=`)` keeps the backslash count to backtick
// positions.
const CODE_SPAN = /(?<!`)(?=`)(?<!(?:^|[^\\])\\(?:\\\\)*)(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;

// An inline HTML comment never renders, so it notifies no one. Only a
// closed, unescaped one counts. Once a `<!--` finds no `-->` after it, no
// later one can, so the scan stops there and stays linear.
function withoutInlineComments(text: string): string {
  let result = "";
  let from = 0;
  let open = text.indexOf(COMMENT_OPEN);
  while (open !== -1) {
    if (isEscaped(text, open)) {
      open = text.indexOf(COMMENT_OPEN, open + 1);
      continue;
    }
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) break;
    result += `${text.slice(from, open)} `;
    from = close + COMMENT_CLOSE.length;
    open = text.indexOf(COMMENT_OPEN, from);
  }
  return result + text.slice(from);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - 1 - backslashes] === "\\") backslashes++;
  return backslashes % 2 === 1;
}

// CommonMark never lets a code span or an inline comment leave its block,
// so a stray backtick in one list item, heading, quote line or table row
// can't swallow mentions in the next. A block ends at a blank line (fenced
// and comment blocks are blank by now), after a heading, around a setext
// underline or thematic break, and before a line that opens a new block. A
// quote's lines are split apart too, which can only show more mentions,
// never fewer.
const BLOCK_START = /^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|>|\|)/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BREAK = /^ {0,3}(?:=+[ \t]*|-+[ \t]*|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function withoutCodeSpans(text: string): string {
  const blocks: string[] = [];
  let block: string[] = [];
  const endBlock = (): void => {
    if (block.length > 0) {
      blocks.push(withoutInlineComments(block.join("\n").replace(CODE_SPAN, " ")));
    }
    block = [];
  };
  let endsAfter = false;
  for (const line of text.split("\n")) {
    // A break line is never block text, and the block ends after it.
    const isBreak = BREAK.test(line);
    if (endsAfter || !line.trim() || BLOCK_START.test(line)) endBlock();
    endsAfter = isBreak || HEADING.test(line);
    if (line.trim() && !isBreak) block.push(line);
  }
  endBlock();
  return blocks.join("\n");
}

// A GitHub handle: letters, digits, and inner hyphens or underscores (never
// trailing), at most 39 characters, optionally followed by /team. Not
// preceded by a letter, digit, `@` or `/`, since those make the @ part of a
// word, an email address or a path; anything else — whitespace,
// punctuation, a markdown emphasis marker, an escaping backslash, a
// backtick that opened no code span — may still open a mention. GitHub
// renders and notifies through all of those, and under-reporting a mention
// is the mistake to avoid.
const MENTION =
  /(^|[^A-Za-z0-9@\/])@([A-Za-z0-9](?:[A-Za-z0-9]|[_-](?=[A-Za-z0-9_])){0,38})(\/[A-Za-z0-9][A-Za-z0-9_-]*)?(?![A-Za-z0-9])/g;

// Each mention once (GitHub handles ignore case), as first written.
function uniqueMentions(mentions: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const mention of mentions) {
    const key = mention.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(mention);
  }
  return unique;
}

function* mentionsIn(text: string): Generator<string> {
  // Paragraph, fence and code-span detection all key off "\n".
  const prose = withoutCodeSpans(withoutCodeAndCommentBlocks(text.replace(/\r\n/g, "\n")));
  for (const match of prose.matchAll(MENTION)) yield `@${match[2]}${match[3] ?? ""}`;
}

/**
 * Who an issue or comment notifies: `@name` and `@org/team` in its title and
 * body, outside code spans, fenced code blocks and HTML comments. Title and
 * body are read apart (a title can't open a code block over the body). Each
 * appears once (GitHub handles ignore case), as first written, in first-seen
 * order. Where the Markdown is ambiguous it errs toward listing a mention.
 */
export function githubFieldMentions(fields: { title?: unknown; body?: unknown }): string[] {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return uniqueMentions([...mentionsIn(text(fields.title)), ...mentionsIn(text(fields.body))]);
}
