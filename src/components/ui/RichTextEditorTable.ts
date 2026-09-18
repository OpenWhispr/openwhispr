import { InputRule, type Editor } from "@tiptap/core";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import {
  DOMParser,
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  addRow,
  cellAround,
  handlePaste as pasteIntoCells,
  isInTable,
  nextCell,
  removeRow,
  selectedRect,
} from "@tiptap/pm/tables";
import { escapeTableCellPipes, parseTableHeaderRow } from "../../utils/markdownTable";

// Notes are stored as Markdown, and a GFM pipe table holds only a header row
// followed by body rows of one-line cells. These extensions keep every table in
// that shape, so the editor never shows a table that saving would change.

/** The prosemirror-markdown state tiptap-markdown passes to serializers. */
interface MarkdownSerializerState {
  nodes: unknown;
  marks: unknown;
  options: object;
  /** Everything written so far. */
  out: string;
  write(content?: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
  renderInline(parent: ProseMirrorNode, fromBlockStart?: boolean): void;
}

type MarkdownSerializerStateClass = new (
  nodes: unknown,
  marks: unknown,
  options: object
) => MarkdownSerializerState;

interface MarkdownStorage {
  markdown: { serializer: { serialize(content: Fragment): string } };
}

const markdownSerializer = (editor: Editor) =>
  (editor.storage as unknown as MarkdownStorage).markdown.serializer;

/** Joins any content into one paragraph; line breaks and block boundaries become spaces. */
function toSingleLine(content: Fragment, schema: Schema): ProseMirrorNode {
  const inline: ProseMirrorNode[] = [];
  let pendingSpace = false;
  const append = (node: ProseMirrorNode) => {
    if (pendingSpace && inline.length) inline.push(schema.text(" "));
    pendingSpace = false;
    inline.push(node);
  };
  const visit = (fragment: Fragment) =>
    fragment.forEach((node) => {
      if (node.isText) {
        append(schema.text(node.text.replace(/\n+/g, " "), node.marks));
      } else if (node.type === schema.linebreakReplacement) {
        append(schema.text(" ", node.marks));
      } else if (node.isInline) {
        append(node);
      } else {
        pendingSpace = true;
        visit(node.content);
        pendingSpace = true;
      }
    });
  visit(content);
  return schema.nodes.paragraph.create(null, inline);
}

/**
 * A cell holding one paragraph. Pasted cells can hold lists, headings or several
 * paragraphs, so they are flattened while parsing, before they can split the
 * table. GFM stores no alignment or column widths, so those are not read.
 */
const singleLineCell = (cell: typeof TableCell, tag: "td" | "th") =>
  cell.extend({
    content: "paragraph",
    parseHTML: () => [
      {
        tag,
        getContent: (dom: globalThis.Node, schema: Schema) =>
          Fragment.from(toSingleLine(DOMParser.fromSchema(schema).parseSlice(dom).content, schema)),
      },
    ],
    addAttributes() {
      return {
        ...this.parent?.(),
        colwidth: { default: null, parseHTML: () => null },
        align: { default: null, parseHTML: () => null },
      };
    },
  });

/** Rebuilds a table with merged cells as a plain grid; a merged cell's text stays in its first slot. */
function unmergeCells(table: ProseMirrorNode, map: TableMap, schema: Schema): ProseMirrorNode {
  const { tableRow, tableHeader, tableCell } = schema.nodes;
  const seen = new Set<number>();
  const rows: ProseMirrorNode[] = [];
  for (let row = 0; row < map.height; row++) {
    const cells: ProseMirrorNode[] = [];
    for (let col = 0; col < map.width; col++) {
      const offset = map.map[row * map.width + col];
      const content = seen.has(offset) ? undefined : table.nodeAt(offset).content;
      seen.add(offset);
      cells.push((row === 0 ? tableHeader : tableCell).createAndFill(null, content));
    }
    rows.push(tableRow.create(null, cells));
  }
  return table.type.create(table.attrs, rows);
}

function normalizeTables(state: EditorState) {
  const { schema, tr } = state;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "table") return !node.isTextblock;
    const map = TableMap.get(node);
    // prosemirror-tables repairs these in its own appendTransaction, which runs this again.
    if (map.problems) return false;
    if (new Set(map.map).size < map.map.length) {
      const from = tr.mapping.map(pos);
      tr.replaceWith(from, from + node.nodeSize, unmergeCells(node, map, schema));
      return false;
    }
    node.forEach((row, rowOffset, rowIndex) =>
      row.forEach((cell, cellOffset) => {
        const cellPos = pos + 1 + rowOffset + 1 + cellOffset;
        const type = rowIndex === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell;
        if (cell.type !== type) tr.setNodeMarkup(tr.mapping.map(cellPos), type, cell.attrs);
        cell.firstChild.forEach((child, offset) => {
          if (child.type !== schema.linebreakReplacement) return;
          const at = tr.mapping.map(cellPos + 2 + offset);
          tr.replaceWith(at, at + 1, schema.text(" ", child.marks));
        });
      })
    );
    return false;
  });
  return tr.docChanged ? tr : null;
}

/**
 * A table on its own, or rows copied from one, which prosemirror-tables pastes
 * cell by cell. Bare cells don't count: several paragraphs pasted into a cell
 * arrive as bare cells, since a cell holds only one paragraph.
 */
function isCellPaste(content: Fragment): boolean {
  const roles: string[] = [];
  content.forEach((node) => roles.push(node.type.spec.tableRole));
  return (
    (roles.length === 1 && roles[0] === "table") ||
    (roles.length > 0 && roles.every((role) => role === "row"))
  );
}

const isRowEmpty = (row: ProseMirrorNode) => {
  let empty = true;
  row.forEach((cell) => {
    if (cell.firstChild.childCount) empty = false;
  });
  return empty;
};

/**
 * Enter in a cell moves to the cell below, adding a row from the last one. On an
 * empty last row it removes the row and leaves the table, like Enter on an empty
 * list item.
 */
function enterInCell({ state, view }: Editor): boolean {
  const $cell = cellAround(state.selection.$head);
  if (!$cell) return false;
  const tr = state.tr;
  const $below = nextCell($cell, "vert", 1);
  if ($below) {
    tr.setSelection(TextSelection.create(tr.doc, $below.pos + $below.nodeAfter.nodeSize - 2));
  } else {
    const rect = selectedRect(state);
    const tablePos = rect.tableStart - 1;
    const lastRow = rect.bottom - 1;
    if (lastRow > 0 && isRowEmpty(rect.table.child(lastRow))) {
      removeRow(tr, rect, lastRow);
      const after = tablePos + tr.doc.nodeAt(tablePos).nodeSize;
      const next = tr.doc.nodeAt(after);
      if (next?.type !== state.schema.nodes.paragraph || next.content.size) {
        tr.insert(after, state.schema.nodes.paragraph.create());
      }
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else {
      addRow(tr, rect, rect.bottom);
      const table = tr.doc.nodeAt(tablePos);
      const cellPos = TableMap.get(table).positionAt(rect.bottom, rect.left, table);
      tr.setSelection(TextSelection.create(tr.doc, rect.tableStart + cellPos + 2));
    }
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Enter at the end of a typed `| Item | Cost |` line turns it into a table. */
function createTableFromHeaderRow({ state, view }: Editor): boolean {
  const { $from, empty } = state.selection;
  const { schema } = state;
  const line = $from.parent;
  if (!empty || line.type !== schema.nodes.paragraph || $from.parentOffset !== line.content.size) {
    return false;
  }
  // Line breaks and mentions read as newlines, which no header row contains.
  const labels = parseTableHeaderRow(line.textBetween(0, line.content.size, undefined, "\n"));
  const index = $from.index(-1);
  if (!labels || !$from.node(-1).canReplaceWith(index, index + 1, schema.nodes.table)) {
    return false;
  }
  const { table, tableRow, tableHeader, tableCell, paragraph } = schema.nodes;
  const header = tableRow.create(
    null,
    labels.map((label) =>
      tableHeader.create(null, paragraph.create(null, label ? schema.text(label) : null))
    )
  );
  const body = tableRow.create(
    null,
    labels.map(() => tableCell.createAndFill())
  );
  const from = $from.before();
  // Its own undo step, so undo gives back the typed line.
  const tr = closeHistory(state.tr).replaceWith(
    from,
    $from.after(),
    table.create(null, [header, body])
  );
  // Table open, header row, body row open, cell open, paragraph open.
  tr.setSelection(TextSelection.create(tr.doc, from + 1 + header.nodeSize + 3));
  view.dispatch(tr.scrollIntoView());
  return true;
}

const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
          // Each cell renders in a state of its own and is escaped as a finished
          // string: rewriting the table's shared output would shift the mark
          // positions tiptap-markdown records for trimming.
          const CellState = state.constructor as MarkdownSerializerStateClass;
          const renderCell = (cell: ProseMirrorNode) => {
            const cellState = new CellState(state.nodes, state.marks, state.options);
            // Mid-line, so a leading "-", "+" or "1." is not escaped.
            cellState.renderInline(cell.firstChild, false);
            return escapeTableCellPipes(cellState.out);
          };
          node.forEach((row, _offset, rowIndex) => {
            const cells: string[] = [];
            row.forEach((cell) => cells.push(renderCell(cell)));
            state.write(`| ${cells.join(" | ")} |`);
            state.ensureNewLine();
            if (rowIndex === 0) {
              state.write(`| ${cells.map(() => "---").join(" | ")} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },

  addKeyboardShortcuts() {
    const insideTable = () => isInTable(this.editor.state);
    return {
      ...this.parent?.(),
      Enter: () => enterInCell(this.editor) || createTableFromHeaderRow(this.editor),
      // A GFM cell cannot hold a line break.
      "Shift-Enter": insideTable,
      "Mod-Enter": insideTable,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("markdownTable"),
        appendTransaction: (transactions, _oldState, state) =>
          transactions.some((tr) => tr.docChanged) ? normalizeTables(state) : null,
        props: {
          // A pasted table or rows go to prosemirror-tables, which fills cells
          // from the caret. Anything else pasted into a table, such as several
          // paragraphs or a table followed by text, is flattened to one line; over
          // selected cells, prosemirror-tables then puts that line in each. This
          // is paste only: a drop lands at the pointer, not at the selection.
          handlePaste: (view, event, slice) => {
            if (!isInTable(view.state) || isCellPaste(slice.content)) return false;
            const line = new Slice(
              Fragment.from(toSingleLine(slice.content, view.state.schema)),
              1,
              1
            );
            // Nothing to insert, such as a screenshot or a pasted rule: leave the
            // table alone. Replacing would delete selected text, and
            // prosemirror-tables would empty selected cells.
            if (!line.size) return true;
            if (view.state.selection instanceof CellSelection) {
              return pasteIntoCells(view, event, line);
            }
            view.dispatch(
              view.state.tr
                .replaceSelection(line)
                .scrollIntoView()
                .setMeta("paste", true)
                .setMeta("uiEvent", "paste")
            );
            return true;
          },
          // Copied cells arrive as bare rows; one cell (a triple-click) copies as its
          // text, and an empty one as a space, since "" would fall through to
          // tiptap-markdown's "[tableRow]". Text copied inside one cell arrives
          // wrapped in every node around that cell. Anything else falls through
          // to tiptap-markdown.
          clipboardTextSerializer: (slice) => {
            const serializer = markdownSerializer(editor);
            const first = slice.content.firstChild;
            if (first?.type.spec.tableRole === "row") {
              return slice.content.childCount === 1 && first.childCount === 1
                ? serializer.serialize(first.firstChild.content) || " "
                : serializer.serialize(
                    Fragment.from(editor.schema.nodes.table.create(null, slice.content))
                  );
            }
            let content = slice.content;
            for (let depth = slice.openStart; depth > 0 && content.childCount === 1; depth--) {
              const node = content.firstChild;
              if (node.type.spec.tableRole?.endsWith("cell")) {
                return serializer.serialize(node.content);
              }
              content = node.content;
            }
            return "";
          },
        },
      }),
      ...(this.parent?.() ?? []),
    ];
  },
});

/**
 * Typing "---" inserts a rule before the current block. In a cell that splits
 * the table, so there the shortcut stays text. Replaces StarterKit's rule.
 */
export const HorizontalRuleOutsideTables = HorizontalRule.extend({
  addInputRules() {
    return (this.parent?.() ?? []).map(
      (rule) =>
        new InputRule({
          find: rule.find,
          handler: (props) => (isInTable(props.state) ? null : rule.handler(props)),
          undoable: rule.undoable,
        })
    );
  },
});

export const markdownTableExtensions = [
  MarkdownTable,
  TableRow,
  singleLineCell(TableHeader, "th"),
  singleLineCell(TableCell, "td"),
];
