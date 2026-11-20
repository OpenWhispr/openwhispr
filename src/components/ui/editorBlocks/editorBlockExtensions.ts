/**
 * every applicable Tiptap MIT extension, each with a
 * Markdown form that survives a save in builds without these extensions (see markdownSyntax.ts).
 */
import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import type { TagParseRule } from "@tiptap/pm/model";
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
        serialize(state: any, node: any) {
          state.renderInline(node);
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

const MarkdownHighlight = Highlight.extend({ addStorage: () => markSpec("==", "==") });
// No Mod-, shortcut: that is the app's Settings shortcut.
const MarkdownSubscript = Subscript.extend({
  addKeyboardShortcuts: () => ({}),
  addStorage: () => markSpec("{sub}", "{/sub}"),
});
const MarkdownSuperscript = Superscript.extend({ addStorage: () => markSpec("{sup}", "{/sup}") });
const MarkdownRubyText = RubyText.extend({
  addStorage: () =>
    markSpec(
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
    markSpec(
      (_s: any, mark: any) =>
        (mark.attrs.color ? `{color:${mark.attrs.color}}` : "") +
        (mark.attrs.fontFamily
          ? `{font:${String(mark.attrs.fontFamily).replace(/[{}]/g, "")}}`
          : ""),
      (_s: any, mark: any) =>
        (mark.attrs.fontFamily ? "{/font}" : "") + (mark.attrs.color ? "{/color}" : "")
    ),
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
