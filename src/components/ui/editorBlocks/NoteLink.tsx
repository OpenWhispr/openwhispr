/**
 * [[note links]].
 *
 * Type "[[" to pick a note; the link is stored as plain Markdown `[[Note title]]`
 * (builds without this extension save it as `\[\[Note title\]\]`, which markdownSyntax
 * reads back). Click a link to open that note. A link whose title matches no
 * note is shown dotted; renaming the note breaks the link (by design for v1).
 */
import { Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { cn } from "../../lib/utils";
import {
  NoteLinkPicker,
  type LinkItem,
  type PickerHandle,
  type PickerProps,
} from "./NoteLinkPicker";
import { escapeMd } from "./markdownSyntax";
import { tb } from "./translate";
import {
  loadNotes,
  onNotesIndexChange,
  openNote,
  resolveTitle,
  searchTitles,
} from "./noteLinkIndex";

export const cleanTitle = (title: string) =>
  title
    .replace(/[[\]\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

export const NoteLink = Node.create({
  name: "noteLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") || el.textContent || "",
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="note-link"]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": "note-link", class: "note-link" }),
      node.attrs.title,
    ];
  },
  renderText({ node }) {
    return `[[${node.attrs.title}]]`;
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement("span");
      dom.setAttribute("data-type", "note-link");
      dom.setAttribute("contenteditable", "false");
      const paint = () => {
        const target = resolveTitle(current.attrs.title);
        dom.className = cn("note-link", !target && "is-unresolved");
        dom.textContent = current.attrs.title;
        dom.title = target
          ? tb("link.open", { title: target.title })
          : tb("link.missing", { title: current.attrs.title });
      };
      paint();
      void loadNotes().then(paint);
      const unsubscribe = onNotesIndexChange(paint);
      dom.addEventListener("mousedown", (event) => event.preventDefault());
      dom.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await loadNotes(0);
        const target = resolveTitle(current.attrs.title);
        if (target) openNote(target.id);
        else paint();
      });
      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          paint();
          return true;
        },
        destroy: unsubscribe,
        ignoreMutation: () => true,
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[[${escapeMd(cleanTitle(node.attrs.title))}]]`);
        },
        parse: {},
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<LinkItem>({
        editor: this.editor,
        pluginKey: new PluginKey("noteLinkPicker"),
        char: "[[",
        allowSpaces: true,
        startOfLine: false,
        allowedPrefixes: null,
        items: async ({ query }) => {
          await loadNotes();
          const q = cleanTitle(query);
          const found: LinkItem[] = searchTitles(q).map((n) => ({ title: n.title, id: n.id }));
          if (q && !found.some((f) => f.title.toLowerCase() === q.toLowerCase())) {
            found.push({ title: q, id: null });
          }
          return found;
        },
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: LinkItem }) => {
          // Also swallow "]]" the user may already have typed after the query.
          const after = editor.state.doc.textBetween(
            range.to,
            Math.min(range.to + 2, editor.state.doc.content.size)
          );
          const to = after === "]]" ? range.to + 2 : range.to;
          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              { type: "noteLink", attrs: { title: cleanTitle(props.title) } },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: pickerRender,
      }),
    ];
  },
});

// ---- Picker UI --------------------------------------------------------------
const PICKER_WIDTH = 288;
const pickerRender: SuggestionOptions<LinkItem>["render"] = () => {
  let component: ReactRenderer<PickerHandle, PickerProps> | null = null;
  const position = (clientRect?: (() => DOMRect | null) | null) => {
    const el = component?.element as HTMLElement | undefined;
    const rect = clientRect?.();
    if (!el || !rect) return;
    el.style.position = "fixed";
    el.style.zIndex = "9999";
    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - PICKER_WIDTH - 8))}px`;
    el.style.top = `${rect.bottom + 6}px`;
  };
  const close = () => {
    component?.destroy();
    component?.element.remove();
    component = null;
  };
  return {
    onStart: (props) => {
      component = new ReactRenderer(NoteLinkPicker, {
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
        close();
        return true;
      }
      return component?.ref?.onKeyDown(props.event) ?? false;
    },
    onExit: close,
  };
};
