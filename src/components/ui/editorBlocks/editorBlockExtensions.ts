/**
 * every applicable Tiptap MIT extension, each with a
 * Markdown form that survives a save in builds without these extensions (see markdownSyntax.ts).
 */
import { Extension, Node, mergeAttributes, type Editor } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { Emoji, gitHubEmojis, shortcodeToEmoji } from "@tiptap/extension-emoji";
import Typography from "@tiptap/extension-typography";
import { TableOfContents, getHierarchicalIndexes } from "@tiptap/extension-table-of-contents";
import Highlight from "@tiptap/extension-highlight";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import Youtube from "@tiptap/extension-youtube";
import Twitch from "@tiptap/extension-twitch";
import UniqueID from "@tiptap/extension-unique-id";
import { FindAndReplace } from "@tiptap/extension-find-and-replace";
import InvisibleCharacters from "@tiptap/extension-invisible-characters";
import { CharacterCount, Focus } from "@tiptap/extensions";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { FontFamily } from "@tiptap/extension-font-family";
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
// Not inside table cells: a GFM pipe table cell has no paragraph to carry it,
// so it would come back as literal text.
const alignSuffix = (node: any, parent?: any) => {
  const a = node.attrs.textAlign;
  if (!a || a === "left" || /^table(Cell|Header)$/.test(parent?.type?.name ?? "")) return "";
  return ` {align:${a}}`;
};

const AlignedParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any) {
          state.renderInline(node);
          const suffix = alignSuffix(node, parent);
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
        serialize(state: any, node: any, parent: any) {
          state.write(`${state.repeat("#", node.attrs.level)} `);
          state.renderInline(node, false);
          const suffix = alignSuffix(node, parent);
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
const MarkdownSubscript = Subscript.extend({ addStorage: () => markSpec("{sub}", "{/sub}") });
const MarkdownSuperscript = Superscript.extend({ addStorage: () => markSpec("{sup}", "{/sup}") });
const MarkdownRubyText = RubyText.extend({
  addStorage: () =>
    markSpec(
      (_s: any, mark: any) =>
        `{ruby:${escapeMd(String(mark.attrs.rt ?? "")).replace(/[{}]/g, "")}}`,
      "{/ruby}"
    ),
});
const MarkdownTextStyle = TextStyle.extend({
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
  onCreate() {
    this.options.onClick = (node: any, pos: number) => editLatex(this.editor, node, pos);
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`$${escapeMd(String(node.attrs.latex ?? ""))}$`);
        },
        parse: {},
      },
    };
  },
});

const MarkdownBlockMath = BlockMath.extend({
  onCreate() {
    this.options.onClick = (node: any, pos: number) => editLatex(this.editor, node, pos);
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

const embedSpec = (label: string) => ({
  markdown: {
    serialize(state: any, node: any) {
      state.write(`[▶ ${label}](${node.attrs.src})`);
      state.closeBlock(node);
    },
    parse: {},
  },
});
const MarkdownYoutube = Youtube.extend({ addStorage: () => embedSpec("YouTube video") });
const MarkdownTwitch = Twitch.extend({ addStorage: () => embedSpec("Twitch video") });

const MarkdownEmoji = Emoji.extend({
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
            if (node.firstChild?.type.name === "paragraph") state.write(" ");
            else state.ensureNewLine();
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
        const items: any[] = (editor.storage as any).tableOfContents?.content ?? [];
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
          link.style.paddingLeft = `${(item.level - 1) * 14}px`;
          link.textContent = item.textContent;
          link.addEventListener("click", (event) => {
            event.preventDefault();
            item.dom?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    ...toggleBlockExtensions,
    Callout,
    TableOfContentsBlock,
    TableOfContents.configure({ anchorTypes: ["heading"], getIndex: getHierarchicalIndexes }),
    MarkdownInlineMath,
    MarkdownBlockMath,
    MarkdownHighlight.configure({ multicolor: false }),
    MarkdownSubscript,
    MarkdownSuperscript,
    MarkdownTextStyle,
    Color,
    FontFamily,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    MarkdownRubyText,
    MarkdownEmoji.configure({ emojis: gitHubEmojis, enableEmoticons: true }),
    // ">>" is the toggle shortcut and "---" a divider / literal text in tables,
    // so keep Typography from turning them into "»" and "—".
    Typography.configure({ laquo: false, raquo: false, emDash: false }),
    MarkdownYoutube.configure({ nocookie: true, controls: true, width: 560, height: 315 }),
    MarkdownTwitch.configure({ width: 560, height: 315 }),
    UniqueID.configure({ types: ["heading", "paragraph", "taskItem", "listItem"] }),
    FindAndReplace,
    FindShortcut,
    InvisibleCharacters.configure({ visible: false }),
    CharacterCount,
    Focus.configure({ className: "rte-has-focus", mode: "deepest" }),
    NoteLink,
    SlashMenu,
  ];
}
