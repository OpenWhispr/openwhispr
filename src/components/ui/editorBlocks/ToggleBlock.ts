/**
 * collapsible toggle blocks.
 *
 * Uses Tiptap's MIT Details extension for the editor UI and stores the block as
 * plain Markdown (the note editor runs tiptap-markdown with html: false, so a
 * <details> tag would not survive):
 *
 *   :::toggle Summary text
 *
 *   Any Markdown, including nested lists and toggles
 *
 *   :::
 *
 * In a build without this extension it reads as two plain lines around the content, and
 * saving there keeps the text, so this editor reads it back as a toggle.
 */
import { InputRule } from "@tiptap/core";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";

const OPEN = /^:::toggle(?:[ \t]+(.*))?$/;
const CLOSE = /^:::[ \t]*$/;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** markdown-it block rule: `:::toggle Title` … `:::`, nesting allowed. */
function toggleBlockPlugin(md: any) {
  md.block.ruler.before(
    "fence",
    "toggle",
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const lineText = (n: number) =>
        state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const open = OPEN.exec(lineText(startLine));
      if (!open) return false;

      // Find the matching close, counting nested toggles.
      let depth = 1;
      let line = startLine + 1;
      for (; line < endLine; line++) {
        if (state.sCount[line] < state.blkIndent) break;
        const text = lineText(line);
        if (OPEN.test(text)) depth++;
        else if (CLOSE.test(text) && --depth === 0) break;
      }
      if (depth !== 0) return false; // unclosed: leave it as plain text
      if (silent) return true;

      const oldParent = state.parentType;
      const oldLineMax = state.lineMax;
      state.parentType = "toggle";
      state.lineMax = line;

      const tokOpen = state.push("toggle_open", "details", 1);
      tokOpen.block = true;
      tokOpen.info = (open[1] || "").trim();
      tokOpen.map = [startLine, line + 1];
      state.md.block.tokenize(state, startLine + 1, line);
      const tokClose = state.push("toggle_close", "details", -1);
      tokClose.block = true;

      state.parentType = oldParent;
      state.lineMax = oldLineMax;
      state.line = line + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] }
  );
  md.renderer.rules.toggle_open = (tokens: any[], idx: number) =>
    `<details><summary>${escapeHtml(tokens[idx].info)}</summary><div data-type="detailsContent">\n`;
  md.renderer.rules.toggle_close = () => `</div></details>\n`;
}

export const ToggleBlock = Details.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^>>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setDetails().run();
        },
      }),
    ];
  },
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: any, node: any) {
          const summary = node.firstChild?.type.name === "detailsSummary" ? node.firstChild : null;
          const content = node.lastChild?.type.name === "detailsContent" ? node.lastChild : null;
          const title = (summary?.textContent || "").replace(/\s*\n\s*/g, " ").trim();
          // Each marker is its own paragraph (blank lines around the content):
          // an editor without this extension joins adjacent lines into one paragraph, which
          // would glue the markers to the content. Verified stable in Phase 0.
          state.write(title ? `:::toggle ${title}` : ":::toggle");
          state.closeBlock(node);
          if (content && content.childCount) state.renderContent(content);
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {
          setup(markdownit: any) {
            markdownit.use(toggleBlockPlugin);
          },
        },
      },
    };
  },
}).configure({ persist: true, HTMLAttributes: { class: "rte-toggle" } });

/** Everything the editor needs for toggles. */
export const toggleBlockExtensions = [ToggleBlock, DetailsSummary, DetailsContent];
