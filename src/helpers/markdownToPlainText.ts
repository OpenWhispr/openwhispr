// Turns a model answer into text that is safe to paste into a plain-text
// field. Every line break is preserved: paragraphs, blank lines and list
// lines survive. This is deliberately NOT stripMarkdownPreview from
// CommandSearch.tsx — that helper collapses newlines into spaces to feed
// one-line search previews and would flatten a multi-paragraph answer.
//
// The rules only touch syntax a human would not type in plain text. A `- `
// bullet, a `1.` number, `2 * 3`, snake_case, `#hashtag` and `x > y` are all
// left exactly as written.
//
// The inline rules are applied per line, so emphasis that spans a line break
// and setext (underlined) headings are out of scope: the prompt suffix that
// asks the model for plain prose is the primary defence, and this helper is
// the floor under a model that drifts back to markdown.

const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_ALIGNMENT_CELL = /^:?-+:?$/;

const WEB_URL = /(?:https?|ftp):\/\/[^\s<>"`]+/;
// Spaces belong to a directory only when another path component follows;
// otherwise the match would swallow the prose after an unquoted filename.
const WINDOWS_PATH =
  /(?:[a-z]:\\|\\\\[^\s\\<>:"|?*`]+\\)(?:[^\\\r\n<>:"|?*`]*\\(?=[^\s\\<>:"|?*`]))*[^\s<>:"|?*`]*/;
const RELATIVE_WINDOWS_PATH =
  /(?<![a-z0-9\\])(?:__[a-z0-9.-][a-z0-9_.-]*__|_[a-z0-9.-][a-z0-9_.-]*_|[a-z0-9.-][a-z0-9_.-]*)\\[^\s<>:"|`]+/;
// Paired underscores in a relative directory are part of its name; any
// surrounding emphasis must stay outside the protected path.
const POSIX_PATH =
  /(?<![a-z0-9/])(?:(?<!~)~\/|\.{1,2}\/|\/|__[a-z0-9.-][a-z0-9_.-]*__\/|_[a-z0-9.-][a-z0-9_.-]*_\/|[a-z0-9.-][a-z0-9_.-]*\/)[^\s<>"`]+/;
const LITERAL_RESOURCE = new RegExp(
  `${WEB_URL.source}|${WINDOWS_PATH.source}|${RELATIVE_WINDOWS_PATH.source}|${POSIX_PATH.source}`,
  "gi"
);

function hasWindowsPathStructure(text: string): boolean {
  // A lone prose escape (under\_score) is ambiguous. Require a path prefix,
  // a separator that cannot be a Markdown escape, or a filename extension.
  return (
    /^(?:[a-z]:\\|\\\\|\.{1,2}\\)/i.test(text) ||
    /\\[a-z0-9]/i.test(text) ||
    /\\[^\\]*\.[a-z0-9]/i.test(text)
  );
}

function stripLinks(text: string, preserve: (content: string) => string): string {
  let result = "";
  let previousEnd = 0;
  for (const match of text.matchAll(/(!?)\[([^\]]*)\]\(/g)) {
    if (match.index < previousEnd) continue;
    const destinationStart = match.index + match[0].length;
    let destinationEnd = destinationStart;
    let depth = 0;
    // A destination can contain nested or escaped parentheses. Its first `)`
    // is not necessarily the end of the link.
    for (; destinationEnd < text.length; destinationEnd += 1) {
      const character = text[destinationEnd];
      if (character === "\\" && destinationEnd + 1 < text.length) {
        destinationEnd += 1;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character)) {
        break;
      }
    }
    const closing = text.slice(destinationEnd).match(/^(?:\s+(?:"[^"]*"|'[^']*'))?\)/);
    if (depth !== 0 || !closing) continue;
    const destination = text.slice(destinationStart, destinationEnd).replace(/\\([\\()])/g, "$1");
    const label = match[2];
    result += text.slice(previousEnd, match.index);
    result += match[1]
      ? label
      : label === destination
        ? preserve(destination)
        : `${label} (${preserve(destination)})`;
    previousEnd = destinationEnd + closing[0].length;
  }
  return result + text.slice(previousEnd);
}

function hasOpenEmphasis(text: string, marker: string): boolean {
  let count = 0;
  for (const match of text.matchAll(/(?<!\\)(\*{1,3}|_{1,3}|~~)/g)) {
    if (match[0] !== marker) continue;
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + marker.length] ?? "";
    if (marker.startsWith("_") && /\w/.test(before) && /\w/.test(after)) continue;
    count += 1;
  }
  return count % 2 === 1;
}

function stripInline(text: string): string {
  // Code, URL destinations and file paths are data, even when they contain
  // markdown punctuation. Use a prefix absent from the input to avoid collisions.
  const literals: string[] = [];
  let placeholderPrefix = "";
  while (text.includes(placeholderPrefix)) placeholderPrefix += "";
  const preserve = (content: string): string => {
    literals.push(content);
    return `${placeholderPrefix}${literals.length - 1}`;
  };
  const withPlaceholders = text.replace(
    /(?<![\\`])(`+)(?!`)(.*?)(?<!`)\1(?!`)/g,
    (_match, _delimiter: string, content: string): string =>
      // Markdown permits padding a code span with one space at either end
      // so literal backticks do not merge with the delimiters.
      preserve(/^ .* $/.test(content) && /[^ ]/.test(content) ? content.slice(1, -1) : content)
  );
  let resourceEnd = 0;
  let resourceContext = "";

  const stripped = stripLinks(withPlaceholders, preserve)
    .replace(
      /(["'])((?:[a-z]:\\|\\\\[^\s\\]+\\|[a-z0-9_.-]+\\|~\/|\.{1,2}\/|\/|[a-z0-9_.-]+\/)[^\r\n]*?)\1/gi,
      (match, quote: string, path: string): string =>
        path.includes("/") || hasWindowsPathStructure(path) ? quote + preserve(path) + quote : match
    )
    .replace(LITERAL_RESOURCE, (resource: string, offset: number, source: string): string => {
      if (!resource.includes("/") && !hasWindowsPathStructure(resource)) return resource;
      // Earlier resources cannot open emphasis; only the surrounding prose can.
      resourceContext += source.slice(resourceEnd, offset);
      resourceEnd = offset + resource.length;
      // A marked-up word after whitespace belongs to prose, not an unquoted
      // directory. Quoted paths were already protected, including such names.
      const proseStart = resource.search(/\s+(?=(?:__\S.*?__|_\S.*?_|~~\S.*?~~)(?:\s|$))/);
      if (proseStart !== -1) {
        const prose = resource.slice(proseStart);
        resourceContext += prose;
        return preserve(resource.slice(0, proseStart)) + prose;
      }
      const closing = resource.match(/(\*{1,3}|_{1,3}|~~)([.,!?;:)\]]*)$/);
      if (closing && hasOpenEmphasis(resourceContext, closing[1])) {
        resourceContext += closing[0];
        return preserve(resource.slice(0, -closing[0].length)) + closing[0];
      }
      return preserve(resource);
    })
    // Escaped punctuation is literal, including at a would-be closing marker.
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_match, literal: string): string => preserve(literal))
    // `**` may sit intraword (intraword bold is legitimate); `__` requires a
    // non-word close that is also not `(`, so dunder identifiers such as
    // `__init__` (immediately followed by a call's `(`) are never mistaken
    // for emphasis, while `__bold__ word` still strips.
    .replace(/(?<!\\)\*\*(\S(?:.*?\S)??)\*\*/g, "$1")
    .replace(/(?<![\w\\])__(\S(?:.*?\S)??)__(?![\w(])/g, "$1")
    .replace(/(?<!\\)~~(\S(?:.*?\S)??)~~/g, "$1")
    // Markers must hug non-space on the inside, not sit inside a word on the
    // outside, and not be escaped — so `2 * 3`, snake_case and `\*` survive.
    // The single-underscore content also may not start or end with `_` itself,
    // so a dunder like `__init__` is never absorbed as `_` + `_init_` + `_`.
    .replace(/(?<![\w*\\])\*(\S(?:.*?\S)??)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_\\])_(?!_)(\S(?:.*?[^\s_])??)_(?![\w_])/g, "$1");

  // A literal can itself hold placeholders (a code span inside a link destination).
  const placeholder = new RegExp(`${placeholderPrefix}(\\d+)`, "g");
  const restore = (text: string): string =>
    text.replace(placeholder, (_match: string, index: string): string =>
      restore(literals[Number(index)])
    );
  return restore(stripped);
}

function splitTableCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let backslashes = 0;
  for (const character of row.trim().slice(1, -1)) {
    if (character === "|" && backslashes % 2 === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  cells.push(cell.trim());
  return cells;
}

export function markdownToPlainText(markdown: string): string {
  const lines: string[] = [];
  const codeLines = new Set<number>();
  let openingFence: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(FENCE_LINE);
    if (openingFence) {
      if (
        fence &&
        fence[1][0] === openingFence[0] &&
        fence[1].length >= openingFence.length &&
        fence[2].trim() === ""
      ) {
        openingFence = null;
      } else {
        codeLines.add(lines.length);
        lines.push(line);
      }
      continue;
    }
    if (fence && (fence[1][0] === "~" || !fence[2].includes("`"))) {
      openingFence = fence[1];
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) continue;

    if (TABLE_ROW.test(line)) {
      const cells = splitTableCells(line);
      if (cells.every((cell) => TABLE_ALIGNMENT_CELL.test(cell))) continue;
      lines.push(cells.map(stripInline).join("\t"));
      continue;
    }

    const block = line
      .replace(/^(\s{0,3}>\s?)+/, "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^(\s*)\*\s+/, "$1- ");
    lines.push(stripInline(block).replace(/[ \t]+$/, ""));
  }

  // Trim only prose padding: code whitespace and table edge cells are data.
  let start = 0;
  let end = lines.length;
  while (start < end && !codeLines.has(start) && /^ *$/.test(lines[start])) start += 1;
  while (end > start && !codeLines.has(end - 1) && /^ *$/.test(lines[end - 1])) end -= 1;
  if (start < end && !codeLines.has(start)) lines[start] = lines[start].replace(/^ +/, "");
  return lines.slice(start, end).join("\n");
}
