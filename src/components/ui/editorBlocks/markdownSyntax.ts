/**
 * Markdown parsing for the note editor's extra blocks and marks.
 *
 * Notes are stored as Markdown with HTML disabled, so every feature has a plain
 * text form. This markdown-it plugin turns those forms into the HTML the Tiptap
 * extensions parse. The forms are chosen so an editor WITHOUT these extensions keeps them when
 * it re-saves a note (verified by test/components/richTextEditorBlocks.test.js). Where the
 * older serializer escapes these forms (\[!NOTE\], \[TOC\], \[\[Title\]\]) the rules
 * accept that form too, at token level, so code blocks and code spans are untouched.
 *
 *   Callout      > [!NOTE] text            (also TIP, IMPORTANT, WARNING, CAUTION)
 *   Table of c.  [TOC]                     (paragraph on its own)
 *   Block math   $$latex$$                 (paragraph on its own, one line)
 *   Inline math  $latex$
 *   Highlight    ==text==
 *   Sub / sup    {sub}x{/sub}  {sup}x{/sup}
 *   Text colour  {color:#e11d48}text{/color}
 *   Font         {font:Georgia}text{/font}
 *   Ruby         {ruby:かんじ}漢字{/ruby}
 *   Alignment    paragraph text {align:center}   (left|center|right|justify)
 *   Note link    [[Note title]]
 *   Video embed  [▶ YouTube video](https://www.youtube-nocookie.com/embed/…)
 *                [▶ Twitch video](https://player.twitch.tv/?…)
 */

// Characters prosemirror-markdown's esc() escapes in text. Latex and attribute
// values are written in this escaped form and unescaped on read, so the stored
// text is identical whichever editor saved it.
const ESCAPED = /\\([`*\\~[\]_])/g;
export const unescapeMd = (s: string) => s.replace(ESCAPED, "$1");
export const escapeMd = (s: string) => s.replace(/[`*\\~[\]_]/g, (c) => `\\${c}`);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CALLOUT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
const CALLOUT_RAW_RE = /^\\?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\?\][ \t]*/i;
const CALLOUT_TEXT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;
const ALIGN_RE = /[ \t]\{align:(left|center|right|justify)\}[ \t]*$/;

const SPAN_OPEN = /^\{(sub|sup|color|font|ruby)(?::((?:\\.|[^{}\\\n]){1,120}))?\}/;
const SPAN_CLOSE = /^\{\/(sub|sup|color|font|ruby)\}/;
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|(rgb|hsl)a?\([\d\s.,%deg/]+\))$/;
const SAFE_FONT = /^[\w\s\-'",.]{1,80}$/;

type SpanFrame = { key: string; value: string };

function spanOpenHtml(key: string, value: string): string | null {
  switch (key) {
    case "sub":
      return "<sub>";
    case "sup":
      return "<sup>";
    case "color":
      return SAFE_COLOR.test(value) ? `<span style="color: ${escapeHtml(value)}">` : null;
    case "font":
      return SAFE_FONT.test(value) ? `<span style="font-family: ${escapeHtml(value)}">` : null;
    case "ruby":
      return value ? "<ruby><rb>" : null;
    default:
      return null;
  }
}

function spanCloseHtml(frame: SpanFrame): string {
  switch (frame.key) {
    case "sub":
      return "</sub>";
    case "sup":
      return "</sup>";
    case "ruby":
      return `</rb><rt>${escapeHtml(frame.value)}</rt></ruby>`;
    default:
      return "</span>";
  }
}

// Any YouTube / Twitch link written as the editor's "▶ … video" link (the node
// stores the link as given and converts it to an embed URL when rendering).
function isYoutubeEmbed(href: string) {
  return /^https:\/\/((www|m)\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//.test(href);
}
function isTwitchEmbed(href: string) {
  return /^https:\/\/((www|player|clips|m)\.)?twitch\.tv\//.test(href);
}

export function markdownSyntax(md: any) {
  // Editors without these extensions save some markers escaped (\[!NOTE\], \[TOC\],
  // \[\[Title\]\]). Each rule below accepts both forms at token level, so text
  // inside code blocks and code spans is never touched.

  // 2) {key:value}…{/key} spans (sub, sup, colour, font, ruby).
  md.inline.ruler.before("emphasis", "attribute_span", (state: any, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false;
    const rest = state.src.slice(state.pos);
    const stack: SpanFrame[] = (state.attributeSpans ||= []); // per paragraph, never leaks

    const close = SPAN_CLOSE.exec(rest);
    if (close) {
      const at = stack.map((f) => f.key).lastIndexOf(close[1]);
      if (at < 0) return false;
      if (!silent) {
        const [frame] = stack.splice(at, 1);
        state.push("html_inline", "", 0).content = spanCloseHtml(frame);
      }
      state.pos += close[0].length;
      return true;
    }

    const open = SPAN_OPEN.exec(rest);
    if (!open || !rest.includes(`{/${open[1]}}`, open[0].length)) return false;
    const value = unescapeMd(open[2] ?? "").trim();
    const html = spanOpenHtml(open[1], value);
    if (!html) return false;
    if (!silent) {
      stack.push({ key: open[1], value });
      state.push("html_inline", "", 0).content = html;
    }
    state.pos += open[0].length;
    return true;
  });

  // 2b) [[Note title]] -> note link (before markdown-it's own [link] rule).
  md.inline.ruler.before("escape", "note_link", (state: any, silent: boolean) => {
    const { src, pos } = state;
    const c = src.charCodeAt(pos);
    if (c !== 0x5b && c !== 0x5c) return false; // "[" or "\" (escaped form)
    const m = /^\\?\[\\?\[((?:\\[^\]]|[^\]\\\n]){1,400}?)\\?\]\\?\]/.exec(src.slice(pos));
    if (!m) return false;
    const title = unescapeMd(m[1]).trim();
    if (!title) return false;
    if (!silent) {
      const t = escapeHtml(title);
      state.push("html_inline", "", 0).content =
        `<span data-type="note-link" data-title="${t}">${t}</span>`;
    }
    state.pos += m[0].length;
    return true;
  });

  // 3) ==highlight==
  md.inline.ruler.before("emphasis", "highlight", (state: any, silent: boolean) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x3d || src.charCodeAt(pos + 1) !== 0x3d) return false;
    if (state.highlightOpen) {
      if (!silent) {
        state.push("html_inline", "", 0).content = "</mark>";
        state.highlightOpen = false;
      }
      state.pos += 2;
      return true;
    }
    const next = src.charAt(pos + 2);
    if (!next || /\s|=/.test(next) || src.indexOf("==", pos + 3) < 0) return false;
    if (!silent) {
      state.push("html_inline", "", 0).content = "<mark>";
      state.highlightOpen = true;
    }
    state.pos += 2;
    return true;
  });

  // 4) $inline math$ (not $$, no space just inside, not followed by a digit).
  md.inline.ruler.before("escape", "math_inline", (state: any, silent: boolean) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) === 0x24) return false;
    if (pos > 0 && src.charCodeAt(pos - 1) === 0x24) return false;
    const m = /^\$((?:\\.|[^$\\\n])+?)\$(?![\d$])/.exec(src.slice(pos));
    if (!m || /^\s|\s$/.test(m[1])) return false;
    if (!silent) {
      const latex = escapeHtml(unescapeMd(m[1]));
      state.push("html_inline", "", 0).content =
        `<span data-type="inline-math" data-latex="${latex}"></span>`;
    }
    state.pos += m[0].length;
    return true;
  });

  // 5) Block-level forms, once inline tokens exist.
  md.core.ruler.push("block_forms", (state: any) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      // Callouts: a blockquote whose first paragraph starts with [!TYPE].
      if (t.type === "blockquote_open" && tokens[i + 2]?.type === "inline") {
        const inline = tokens[i + 2];
        const m = CALLOUT_RAW_RE.exec(inline.content);
        if (m && tokens[i + 1].type === "paragraph_open") {
          const type = m[1].toLowerCase();
          t.meta = { ...(t.meta || {}), callout: type };
          for (let j = i + 1, depth = 0; j < tokens.length; j++) {
            if (tokens[j].type === "blockquote_open") depth++;
            if (tokens[j].type === "blockquote_close") {
              if (depth === 0) {
                tokens[j].meta = { ...(tokens[j].meta || {}), callout: type };
                break;
              }
              depth--;
            }
          }
          inline.content = inline.content.slice(m[0].length);
          const first = inline.children?.[0];
          if (first?.type === "text") first.content = first.content.replace(CALLOUT_TEXT_RE, "");
          while (
            inline.children?.length &&
            ["softbreak", "hardbreak"].includes(inline.children[0].type)
          )
            inline.children.shift();
          if (
            inline.children?.length &&
            inline.children[0].type === "text" &&
            !inline.children[0].content
          )
            inline.children.shift();
          if (!inline.children?.length) tokens.splice(i + 1, 3); // marker-only paragraph
        }
      }

      if (t.type !== "inline") continue;
      const open = tokens[i - 1];
      const close = tokens[i + 1];
      const own = open?.type === "paragraph_open" && close?.type === "paragraph_close";
      const text = t.content.trim();

      if (own && /^\\?\[TOC\\?\]$/.test(text)) {
        replaceParagraph(state, i, `<div data-type="table-of-contents"></div>\n`);
        i--;
        continue;
      }
      const block = own && /^\$\$([\s\S]+?)\$\$$/.exec(text);
      if (block) {
        const latex = escapeHtml(unescapeMd(block[1].trim()));
        replaceParagraph(state, i, `<div data-type="block-math" data-latex="${latex}"></div>\n`);
        i--;
        continue;
      }
      const kids = t.children || [];
      if (
        own &&
        kids.length === 3 &&
        kids[0].type === "link_open" &&
        kids[2].type === "link_close"
      ) {
        const href = kids[0].attrGet("href") || "";
        const label = kids[1]?.content || "";
        if (!label.startsWith("▶")) {
          // ordinary link that happens to point at a video: leave it a link
        } else if (isYoutubeEmbed(href)) {
          replaceParagraph(
            state,
            i,
            `<div data-youtube-video><iframe src="${escapeHtml(href)}"></iframe></div>\n`
          );
          i--;
          continue;
        }
        if (isTwitchEmbed(href)) {
          replaceParagraph(
            state,
            i,
            `<div data-twitch-video><iframe src="${escapeHtml(href)}"></iframe></div>\n`
          );
          i--;
          continue;
        }
      }

      // Alignment suffix on paragraphs and headings.
      if (
        (open?.type === "paragraph_open" || open?.type === "heading_open") &&
        ALIGN_RE.test(t.content)
      ) {
        const align = ALIGN_RE.exec(t.content)![1];
        t.content = t.content.replace(ALIGN_RE, "");
        const last = kids[kids.length - 1];
        if (last?.type === "text") last.content = last.content.replace(ALIGN_RE, "");
        open.attrSet("style", `text-align: ${align}`);
      }
    }
  });

  const renderQuote =
    (tag: "open" | "close") => (tokens: any[], idx: number, options: any, env: any, self: any) => {
      const type = tokens[idx].meta?.callout;
      if (!type) return self.renderToken(tokens, idx, options);
      return tag === "open"
        ? `<div data-type="callout" data-callout="${escapeHtml(type)}">\n`
        : `</div>\n`;
    };
  md.renderer.rules.blockquote_open = renderQuote("open");
  md.renderer.rules.blockquote_close = renderQuote("close");
}

function replaceParagraph(state: any, inlineIndex: number, html: string) {
  const token = new state.Token("html_block", "", 0);
  token.content = html;
  token.block = true;
  state.tokens.splice(inlineIndex - 1, 3, token);
}

export { CALLOUT_TYPES };
