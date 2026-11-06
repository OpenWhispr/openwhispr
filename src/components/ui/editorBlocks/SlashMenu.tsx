/**
 * "/" command menu. Type "/" after a space or at the start of
 * a line, filter by typing, Enter to run. Every editor block is reachable here.
 * Labels come from notes.editor.blocks.*; filtering also matches English
 * keywords so "/table" works in any language.
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { insertEmptyTable } from "../RichTextEditorTable";
import { promptInline } from "./inlinePrompt";
import { OPEN_FIND_EVENT } from "./events";
import { tb } from "./translate";
import { SlashMenuList, type ListHandle, type ListProps } from "./SlashMenuList";

type Run = (editor: Editor) => unknown;
type Group = "basic" | "blocks" | "style" | "tools";
export interface SlashItem {
  id: string;
  group: Group;
  title: () => string;
  hint?: () => string;
  keywords?: string;
  run: Run;
}

const chain = (editor: Editor) => editor.chain().focus() as any;

/** [translation key under notes.editor.blocks.colors, CSS colour] */
export const COLORS: [string, string][] = [
  ["red", "#e11d48"],
  ["orange", "#ea580c"],
  ["yellow", "#ca8a04"],
  ["green", "#16a34a"],
  ["blue", "#2563eb"],
  ["purple", "#9333ea"],
  ["gray", "#6b7280"],
];
/** [translation key under notes.editor.blocks.fonts, CSS font family] */
export const FONTS: [string, string][] = [
  ["serif", "Georgia"],
  ["monospace", "Menlo"],
  ["rounded", "Arial Rounded MT Bold"],
];
const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const;
const ALIGNS = ["left", "center", "right", "justify"] as const;
const label = (key: string, params?: Record<string, unknown>) => () => tb(key, params);

export const SLASH_ITEMS: SlashItem[] = [
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    group: "basic" as Group,
    title: label("slash.heading", { level }),
    keywords: `h${level} heading title`,
    run: (e: Editor) => chain(e).setNode("heading", { level }).run(),
  })),
  {
    id: "ul",
    group: "basic",
    title: label("slash.bulletList"),
    keywords: "ul bullet list",
    run: (e) => chain(e).toggleBulletList().run(),
  },
  {
    id: "ol",
    group: "basic",
    title: label("slash.orderedList"),
    keywords: "ol ordered numbered list",
    run: (e) => chain(e).toggleOrderedList().run(),
  },
  {
    id: "task",
    group: "basic",
    title: label("slash.taskList"),
    keywords: "todo task check checkbox",
    run: (e) => chain(e).toggleTaskList().run(),
  },
  {
    id: "quote",
    group: "basic",
    title: label("slash.quote"),
    keywords: "blockquote quote",
    run: (e) => chain(e).toggleBlockquote().run(),
  },
  {
    id: "hr",
    group: "basic",
    title: label("slash.divider"),
    keywords: "hr rule line divider",
    run: (e) => chain(e).setHorizontalRule().run(),
  },
  {
    id: "table",
    group: "basic",
    title: label("slash.table"),
    keywords: "table grid",
    run: (e) => insertEmptyTable(e),
  },
  {
    id: "code",
    group: "basic",
    title: label("slash.codeBlock"),
    hint: label("slash.codeHint"),
    keywords: "code snippet",
    run: (e) => chain(e).toggleCodeBlock().run(),
  },

  {
    id: "link",
    group: "blocks",
    title: label("slash.noteLink"),
    hint: label("slash.noteLinkHint"),
    keywords: "link note page reference wiki backlink",
    run: (e) => chain(e).insertContent("[[").run(),
  },
  {
    id: "toggle",
    group: "blocks",
    title: label("slash.toggle"),
    hint: () => ">> + space",
    keywords: "toggle collapse details fold",
    run: (e) => chain(e).setDetails().run(),
  },
  ...CALLOUTS.map((type) => ({
    id: `callout-${type}`,
    group: "blocks" as Group,
    title: () => tb("slash.callout", { type: tb(`callout.${type}`) }),
    keywords: `callout admonition alert box ${type}`,
    run: (e: Editor) => chain(e).setCallout(type).run(),
  })),
  {
    id: "toc",
    group: "blocks",
    title: label("slash.toc"),
    keywords: "toc outline headings contents",
    run: (e) => chain(e).insertToc().run(),
  },
  {
    id: "math-block",
    group: "blocks",
    title: label("slash.mathBlock"),
    hint: () => "LaTeX",
    keywords: "math equation formula latex katex",
    run: async (e) => {
      const latex = await promptInline(e, { placeholder: tb("prompt.latexBlock") });
      if (latex) chain(e).insertBlockMath({ latex }).run();
    },
  },
  {
    id: "math-inline",
    group: "blocks",
    title: label("slash.inlineMath"),
    hint: label("slash.inlineMathHint"),
    keywords: "math equation formula latex",
    run: async (e) => {
      const latex = await promptInline(e, { placeholder: tb("prompt.latexInline") });
      if (latex) chain(e).insertInlineMath({ latex }).run();
    },
  },
  {
    id: "youtube",
    group: "blocks",
    title: label("slash.youtube"),
    keywords: "youtube embed video",
    run: async (e) => {
      const src = await promptInline(e, { placeholder: tb("prompt.youtube") });
      if (src) chain(e).setYoutubeVideo({ src }).run();
    },
  },
  {
    id: "twitch",
    group: "blocks",
    title: label("slash.twitch"),
    keywords: "twitch embed stream clip video",
    run: async (e) => {
      const src = await promptInline(e, { placeholder: tb("prompt.twitch") });
      if (src) chain(e).setTwitchVideo({ src }).run();
    },
  },
  {
    id: "emoji",
    group: "blocks",
    title: label("slash.emoji"),
    hint: label("slash.emojiHint"),
    keywords: "emoji smiley",
    run: async (e) => {
      const name = await promptInline(e, { placeholder: tb("prompt.emoji") });
      if (name) chain(e).setEmoji(name.replace(/:/g, "").toLowerCase()).run();
    },
  },

  {
    id: "highlight",
    group: "style",
    title: label("slash.highlight"),
    hint: () => "⌘⇧H",
    keywords: "highlight marker mark",
    run: (e) => chain(e).toggleHighlight().run(),
  },
  {
    id: "sub",
    group: "style",
    title: label("slash.subscript"),
    hint: () => "⌘,",
    keywords: "subscript sub",
    run: (e) => chain(e).toggleSubscript().run(),
  },
  {
    id: "sup",
    group: "style",
    title: label("slash.superscript"),
    hint: () => "⌘.",
    keywords: "superscript sup power",
    run: (e) => chain(e).toggleSuperscript().run(),
  },
  ...COLORS.map(([key, value]) => ({
    id: `color-${key}`,
    group: "style" as Group,
    title: () => tb("slash.color", { name: tb(`colors.${key}`) }),
    keywords: `color colour ${key}`,
    run: (e: Editor) => chain(e).setColor(value).run(),
  })),
  {
    id: "color-default",
    group: "style",
    title: () => tb("slash.color", { name: tb("colors.default") }),
    keywords: "color colour reset default",
    run: (e) => chain(e).unsetColor().run(),
  },
  ...FONTS.map(([key, value]) => ({
    id: `font-${key}`,
    group: "style" as Group,
    title: () => tb("slash.font", { name: tb(`fonts.${key}`) }),
    keywords: `font family typeface ${key}`,
    run: (e: Editor) => chain(e).setFontFamily(value).run(),
  })),
  {
    id: "font-default",
    group: "style",
    title: () => tb("slash.font", { name: tb("fonts.default") }),
    keywords: "font reset default",
    run: (e) => chain(e).unsetFontFamily().run(),
  },
  {
    id: "ruby",
    group: "style",
    title: label("slash.ruby"),
    hint: label("slash.rubyHint"),
    keywords: "ruby furigana pronunciation japanese",
    run: async (e) => {
      const hasSelection = !e.state.selection.empty;
      const answer = await promptInline(e, {
        placeholder: tb(hasSelection ? "prompt.reading" : "prompt.textReading"),
      });
      if (!answer) return;
      if (hasSelection) return chain(e).setRubyText({ rt: answer }).run();
      const [base, rt] = answer.split("|").map((s) => s.trim());
      if (!base || !rt) return;
      chain(e)
        .insertContent({ type: "text", text: base, marks: [{ type: "rubyText", attrs: { rt } }] })
        .run();
    },
  },
  ...ALIGNS.map((dir) => ({
    id: `align-${dir}`,
    group: "style" as Group,
    title: () => tb("slash.align", { dir: tb(`align.${dir}`) }),
    keywords: `align alignment ${dir}`,
    run: (e: Editor) => chain(e).setTextAlign(dir).run(),
  })),

  {
    id: "find",
    group: "tools",
    title: label("slash.find"),
    hint: () => "⌘F",
    keywords: "find search replace",
    run: (e) => window.dispatchEvent(new CustomEvent(OPEN_FIND_EVENT, { detail: { editor: e } })),
  },
  {
    id: "invisible",
    group: "tools",
    title: label("slash.invisible"),
    keywords: "invisible whitespace spaces",
    run: (e) => chain(e).toggleInvisibleCharacters().run(),
  },
];

function filterItems(query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) =>
    `${item.title()} ${item.keywords ?? ""} ${tb(`groups.${item.group}`)}`.toLowerCase().includes(q)
  );
}

const MENU_WIDTH = 288;
const render: SuggestionOptions<SlashItem>["render"] = () => {
  let component: ReactRenderer<ListHandle, ListProps> | null = null;
  const position = (clientRect?: (() => DOMRect | null) | null) => {
    const el = component?.element as HTMLElement | undefined;
    const rect = clientRect?.();
    if (!el || !rect) return;
    el.style.position = "fixed";
    el.style.zIndex = "9999";
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8))}px`;
    const below = rect.bottom + 6;
    el.style.top =
      below + 330 > window.innerHeight ? `${Math.max(8, rect.top - 330)}px` : `${below}px`;
  };
  return {
    onStart: (props) => {
      component = new ReactRenderer(SlashMenuList, {
        props: { items: props.items, command: props.command },
        editor: props.editor,
      });
      document.body.appendChild(component.element);
      position(props.clientRect);
    },
    onUpdate: (props) => {
      component?.updateProps({ items: props.items, command: props.command });
      position(props.clientRect);
    },
    onKeyDown: (props) => {
      if (props.event.key === "Escape") {
        component?.destroy();
        component?.element.remove();
        component = null;
        return true;
      }
      return component?.ref?.onKeyDown(props.event) ?? false;
    },
    onExit: () => {
      component?.destroy();
      component?.element.remove();
      component = null;
    },
  };
};

export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run();
          void props.run(editor);
        },
        render,
      }),
    ];
  },
});
