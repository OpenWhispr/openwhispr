/**
 * every applicable Tiptap MIT extension, each with a
 * Markdown form that survives a save in builds without these extensions (see markdownSyntax.ts).
 */
import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Mark, type TagParseRule } from "@tiptap/pm/model";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { Emoji, gitHubEmojis, shortcodeToEmoji } from "@tiptap/extension-emoji";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { FindAndReplace } from "@tiptap/extension-find-and-replace";
import InvisibleCharacters from "@tiptap/extension-invisible-characters";
import { CharacterCount } from "@tiptap/extensions";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Color, FontFamily, TextStyle } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import { RubyText } from "@tiptap/extension-ruby-text";
import { markdownSyntax, escapeMd } from "./markdownSyntax";
import { toggleBlockExtensions } from "./ToggleBlock";
import { editLatex } from "./mathEditor";
import { OPEN_FIND_EVENT } from "./events";
import { SlashMenu } from "./SlashMenu";
import { tb } from "./translate";
import { NoteLink } from "./NoteLink";

/** Registers the shared markdown-it plugin once (any extension's parse.setup works). */
const MarkdownSyntaxExtras = Extension.create({
  name: "markdownSyntaxExtras",
  addStorage() {
    return { markdown: { parse: { setup: (md: any) => md.use(markdownSyntax) } } };
  },
});

// ---- Paragraph / heading with alignment suffix ------------------------------
const alignSuffix = (node: any) => {
  const a = node.attrs.textAlign;
  if (!a || a === "left" || !node.content.size) return "";
  return ` {align:${a}}`;
};

const AlignedParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          // A list item's first paragraph never becomes a block (see markdownSyntax).
          const listFirst = index === 0 && /^(listItem|taskItem)$/.test(parent?.type?.name);
          state.blockMathText =
            !listFirst && /^\$\$[\s\S]+?\$\$$/.test(node.textContent.trim()) ? node : null;
          state.renderInline(node);
          state.blockMathText = null;
          const suffix = alignSuffix(node);
          if (suffix) state.write(suffix);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

const AlignedHeading = Heading.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`${state.repeat("#", node.attrs.level)} `);
          state.renderInline(node, false);
          const suffix = alignSuffix(node);
          if (suffix) state.write(suffix);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

// ---- Marks ------------------------------------------------------------------
const markSpec = (open: any, close: any) => ({
  markdown: {
    serialize: { open, close, mixable: true, expelEnclosingWhitespace: true },
    parse: {},
  },
});
// {sub}…{/sub}, {color:…}…{/color} and the like open and close anywhere, so they
// leave edge spaces in place and stay out of tiptap-markdown's delimiter mover.
// That mover shifts a delimiter past spaces and punctuation until CommonMark would
// accept it, and it assumes the same fixed string at both ends: it wrote the
// source of the {color:…} function into the note, and cut {/sub} short.
const braceMarkSpec = (open: any, close: any) => ({
  markdown: { serialize: { open, close, mixable: true }, parse: {} },
});
// Written outside **, *, ~~ and == (as text styles already are), so those land
// next to the text and never get moved into a {sub}.
const BRACE_MARK_PRIORITY = 101;

const MarkdownHighlight = Highlight.extend({ addStorage: () => markSpec("==", "==") });
// No Mod-, shortcut: that is the app's Settings shortcut.
const MarkdownSubscript = Subscript.extend({
  priority: BRACE_MARK_PRIORITY,
  addKeyboardShortcuts: () => ({}),
  addStorage: () => braceMarkSpec("{sub}", "{/sub}"),
});
const MarkdownSuperscript = Superscript.extend({
  priority: BRACE_MARK_PRIORITY,
  addStorage: () => braceMarkSpec("{sup}", "{/sup}"),
});
const MarkdownRubyText = RubyText.extend({
  priority: BRACE_MARK_PRIORITY,
  addStorage: () =>
    braceMarkSpec(
      (_s: any, mark: any) =>
        `{ruby:${escapeMd(String(mark.attrs.rt ?? "")).replace(/[{}]/g, "")}}`,
      "{/ruby}"
    ),
});
// Only spans the Markdown parser or this editor wrote: colours and fonts in pasted
// web HTML would be saved as {color:…}/{font:…} markers.
const MarkdownTextStyle = TextStyle.extend({
  parseHTML() {
    return this.parent!().map((rule) => ({
      ...(rule as TagParseRule),
      tag: "span[data-text-style]",
    }));
  },
  addStorage: () =>
    braceMarkSpec(
      (_s: any, mark: any) =>
        (mark.attrs.color ? `{color:${mark.attrs.color}}` : "") +
        (mark.attrs.fontFamily
          ? `{font:${String(mark.attrs.fontFamily).replace(/[{}]/g, "")}}`
          : ""),
      (_s: any, mark: any) =>
        (mark.attrs.fontFamily ? "{/font}" : "") + (mark.attrs.color ? "{/color}" : "")
    ),
});

// ---- Text -------------------------------------------------------------------
// tiptap-markdown's text serializer, plus "$". The parser reads two "$" in a block
// as a formula, so text like "$HOME/$USER", or a "$" against a formula, would
// reopen as math. Only a "$" that could pair is written "\$" (every Markdown reader
// takes it as "$"): prices, "$$" and a single "$" save as typed.
const isInlineMath = (node: any) => node?.type.name === "inlineMath";

// The character beside node `i` of `parent` in direction `dir` (block edges
// count as a space). Another node's character only counts when nothing is
// written between the two (same marks); otherwise it is unknown ("x").
const besideText = (parent: any, i: number, dir: 1 | -1) => {
  const j = i + dir;
  if (j < 0 || j >= parent.childCount) return " ";
  const other = parent.child(j);
  if (!other.isText || !Mark.sameSet(other.marks, parent.child(i).marks)) return "x";
  return dir < 0 ? other.text.slice(-1) : other.text.charAt(0);
};

// Whether a formula is written straight against node `i` (same marks, so no
// delimiter between them).
const touchesFormula = (parent: any, i: number, dir: 1 | -1) => {
  const other = parent.maybeChild(i + dir);
  return isInlineMath(other) && Mark.sameSet(other.marks, parent.child(i).marks);
};

// "index:offset" of every "$" in `parent`'s text to write as "\$". Nodes are
// immutable, so a block's answer holds as long as the block does.
const escapedDollars = new WeakMap<object, Map<boolean, Set<string>>>();
const dollarsToEscape = (parent: any, blockMath: boolean): Set<string> => {
  let byMode = escapedDollars.get(parent);
  if (!byMode) escapedDollars.set(parent, (byMode = new Map()));
  let found = byMode.get(blockMath);
  if (found) return found;
  found = new Set();
  byMode.set(blockMath, found);

  // Each "$" (or run of "$", which can neither open nor close) in reading order:
  // whether it could open or close a formula, and its line. A hard break or a code
  // span ends the line for this purpose: no formula reaches across either. The
  // opening "$" of a real formula can close an earlier "$" too, except after a
  // space (the parser takes no pair with a space just inside it).
  type Dollar = { keys?: string[]; open: boolean; close: boolean; forced?: boolean; line: number };
  const dollars: Dollar[] = [];
  let line = 0;
  parent.forEach((child: any, _offset: number, i: number) => {
    if (isInlineMath(child)) {
      const close = /\S/.test(besideText(parent, i, -1));
      return void dollars.push({ open: false, close, line });
    }
    if (child.type.name === "hardBreak") return void line++;
    if (!child.isText) return;
    if (child.marks.some((m: any) => m.type.name === "code")) return void line++;
    const text: string = child.text;
    for (let at = text.indexOf("$"); at >= 0;) {
      let end = at;
      while (text[end + 1] === "$") end++;
      const single = end === at;
      const before = at > 0 ? text[at - 1] : besideText(parent, i, -1);
      const after = end + 1 < text.length ? text[end + 1] : besideText(parent, i, 1);
      const keys: string[] = [];
      for (let k = at; k <= end; k++) keys.push(`${i}:${k}`);
      dollars.push({
        keys,
        line,
        open: single && /\S/.test(after) && after !== "$" && before !== "$",
        close: single && /\S/.test(before) && before !== "$" && !/[\d$]/.test(after),
        // Straight against a formula: "a$$x$" stops it opening, "$x$$5" stops it
        // closing. And "$$x$$" on its own would read back as block math.
        forced:
          blockMath ||
          (at === 0 && touchesFormula(parent, i, -1)) ||
          (end === text.length - 1 && touchesFormula(parent, i, 1)),
      });
      at = text.indexOf("$", end + 1);
    }
  });
  const closeAfter: boolean[] = [];
  for (let k = dollars.length - 1, any = false; k >= 0; k--) {
    if (k + 1 < dollars.length && dollars[k + 1].line !== dollars[k].line) any = false;
    closeAfter[k] = any;
    any ||= dollars[k].close;
  }
  let openBefore = false;
  dollars.forEach((d, k) => {
    if (k > 0 && dollars[k - 1].line !== d.line) openBefore = false;
    if (d.keys && (d.forced || (d.open && closeAfter[k]) || (d.close && openBefore)))
      d.keys.forEach((key) => found.add(key));
    if (d.keys) openBefore ||= d.open;
  });
  return found;
};

const MarkdownText = Node.create({
  name: "text",
  group: "inline",
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          const html = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const text: string = node.text;
          const escape = state.inAutolink
            ? null
            : dollarsToEscape(parent, state.blockMathText === parent);
          if (!escape?.size) return state.text(html(text));
          // Marked text arrives without its edge spaces; offsets are the node's own.
          const shift = parent.child(index).text.indexOf(text);
          // state.text escapes "\" itself, so each "\$" is written unescaped. Only
          // the first piece is at the start of the line.
          let from = 0;
          for (let at = text.indexOf("$"); at >= 0; at = text.indexOf("$", at + 1)) {
            if (!escape.has(`${index}:${at + shift}`)) continue;
            if (at > from) state.text(html(text.slice(from, at)));
            state.text("\\$", false);
            state.atBlockStart = false;
            from = at + 1;
          }
          state.text(html(text.slice(from)));
        },
        parse: {},
      },
    };
  },
});

// ---- Nodes ------------------------------------------------------------------
// Click a formula to edit it (needs the editor, which configure() can't see).
const MarkdownInlineMath = InlineMath.extend({
  addNodeView() {
    this.options.onClick = (node: any, pos: number) => editLatex(this.editor, node, pos);
    return this.parent!();
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          // escapeMd's characters plus $, which would end the formula early.
          const latex = String(node.attrs.latex ?? "").replace(/[`*\\~[\]_$]/g, (c) => `\\${c}`);
          state.write(`$${latex}$`);
        },
        parse: {},
      },
    };
  },
});

const MarkdownBlockMath = BlockMath.extend({
  addNodeView() {
    this.options.onClick = (node: any, pos: number) => editLatex(this.editor, node, pos);
    return this.parent!();
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          // One line: builds without these extensions join a paragraph's lines.
          const latex = String(node.attrs.latex ?? "").replace(/\s*\n\s*/g, " ");
          state.write(`$$${escapeMd(latex)}$$`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

const MarkdownEmoji = Emoji.extend({
  // Its plugin turns every typed or pasted emoji character into a node, which
  // drops the character's marks (code, link, bold). Characters stay text;
  // :shortcode: input still inserts an emoji.
  addProseMirrorPlugins: () => [],
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: any, node: any) {
          const item = shortcodeToEmoji(node.attrs.name, gitHubEmojis);
          state.write(item?.emoji ?? `:${node.attrs.name}:`);
        },
        parse: {},
      },
    };
  },
});

/** Callout block: > [!NOTE] … */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-callout") || "note",
        renderHTML: (attrs) => ({ "data-callout": attrs.type }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "callout", class: "callout" }),
      0,
    ];
  },
  addCommands() {
    return {
      setCallout:
        (type: string) =>
        ({ commands }: any) =>
          commands.wrapIn(this.name, { type }),
    } as any;
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.wrapBlock("> ", null, node, () => {
            state.write(`[!${String(node.attrs.type).toUpperCase()}]`);
            if (node.firstChild.type.name === "paragraph") state.write(" ");
            else state.closeBlock(node);
            state.renderContent(node);
          });
        },
        parse: {},
      },
    };
  },
});

/** Table of contents block: [TOC], rendered from the document's headings. */
export const TableOfContentsBlock = Node.create({
  name: "tableOfContentsBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" })];
  },
  addNodeView() {
    return ({ editor }: { editor: Editor }) => {
      const dom = document.createElement("div");
      dom.className = "table-of-contents";
      dom.setAttribute("contenteditable", "false");
      const render = () => {
        const items: { level: number; text: string; pos: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "heading" && node.textContent)
            items.push({ level: node.attrs.level, text: node.textContent, pos });
        });
        const top = Math.min(...items.map((item) => item.level));
        dom.replaceChildren();
        const title = document.createElement("div");
        title.className = "table-of-contents-title";
        title.textContent = tb("toc.title");
        dom.appendChild(title);
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "table-of-contents-empty";
          empty.textContent = tb("toc.empty");
          dom.appendChild(empty);
        }
        for (const item of items) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "table-of-contents-item";
          link.style.paddingInlineStart = `${(item.level - top) * 14}px`;
          link.textContent = item.text;
          link.addEventListener("click", (event) => {
            event.preventDefault();
            (editor.view.nodeDOM(item.pos) as HTMLElement | null)?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          });
          dom.appendChild(link);
        }
      };
      render();
      editor.on("update", render);
      return { dom, destroy: () => editor.off("update", render), ignoreMutation: () => true };
    };
  },
  addCommands() {
    return {
      insertToc:
        () =>
        ({ commands }: any) =>
          commands.insertContent({ type: this.name }),
    } as any;
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write("[TOC]");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** Find & replace panel opens with Mod-f; RichTextEditor listens for OPEN_FIND_EVENT. */
const FindShortcut = Extension.create({
  name: "findShortcut",
  addKeyboardShortcuts() {
    return {
      "Mod-f": () => {
        window.dispatchEvent(new CustomEvent(OPEN_FIND_EVENT, { detail: { editor: this.editor } }));
        return true;
      },
    };
  },
});

const lowlight = createLowlight(common);

/**
 * Every editor block and mark beyond StarterKit. StarterKit must be configured with
 * paragraph/heading/codeBlock off: AlignedParagraph, AlignedHeading and
 * CodeBlockLowlight replace them.
 */
export function createEditorBlockExtensions() {
  return [
    MarkdownSyntaxExtras,
    MarkdownText,
    AlignedParagraph,
    AlignedHeading.configure({ levels: [1, 2, 3] }),
    // Unlabelled blocks stay plain: auto-detecting the language re-scans the whole
    // block on every keystroke.
    CodeBlockLowlight.configure({
      lowlight: {
        ...lowlight,
        highlightAuto: (code: string) => lowlight.highlight("plaintext", code),
      },
    }),
    ...toggleBlockExtensions,
    Callout,
    TableOfContentsBlock,
    MarkdownInlineMath,
    MarkdownBlockMath,
    MarkdownHighlight.configure({ multicolor: false }),
    MarkdownSubscript,
    MarkdownSuperscript,
    MarkdownTextStyle.configure({ HTMLAttributes: { "data-text-style": "" } }),
    Color,
    FontFamily,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    MarkdownRubyText,
    // No fallback images: they load from a CDN the app's CSP blocks.
    MarkdownEmoji.configure({
      emojis: gitHubEmojis.map((emoji) => ({ ...emoji, fallbackImage: undefined })),
    }),
    // ">>" is the toggle shortcut and "---" a divider / literal text in tables,
    // so keep Typography from turning them into "»" and "—". (c), (r), (tm) and
    // (sm) are common in ordinary text, so they stay as typed.
    Typography.configure({
      laquo: false,
      raquo: false,
      emDash: false,
      copyright: false,
      registeredTrademark: false,
      trademark: false,
      servicemark: false,
    }),
    FindAndReplace,
    FindShortcut,
    InvisibleCharacters.configure({ visible: false }),
    CharacterCount,
    NoteLink,
    SlashMenu,
  ];
}
