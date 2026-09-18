const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Runs the note editor's real extension list in happy-dom. Tables have to leave
// the editor as GFM pipe tables, and the editor must not show anything a pipe
// table can't store.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "DOMParser",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "ClipboardEvent",
  "DataTransfer",
  "DragEvent",
  // For the table menu (React + Radix).
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "ResizeObserver",
  "DOMRect",
];
// tiptap-markdown's placeholder for a node it can't write as Markdown.
const LOST_NODE = /\[(table|tableRow|tableHeader|tableCell|hardBreak)\]/;
const TABLE = "| Name | Owner |\n| --- | --- |\n| Budget | Ana |\n| Hiring | Raj |";

let happyWindow;
let Editor;
let CellSelection;
let Selection;
let createRichTextExtensions;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  ({ createRichTextExtensions } =
    await import("../../src/components/ui/RichTextEditorExtensions.ts"));
  // Same CommonJS builds the extensions load, so ProseMirror stays one instance.
  ({ Editor } = require("@tiptap/core"));
  ({ CellSelection } = require("@tiptap/pm/tables"));
  ({ Selection } = require("@tiptap/pm/state"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const createEditor = (markdown) =>
  new Editor({
    element: happyWindow.document.createElement("div"),
    extensions: createRichTextExtensions(""),
    content: markdown,
  });

function markdownOf(editor) {
  const markdown = editor.storage.markdown.getMarkdown();
  assert.doesNotMatch(markdown, LOST_NODE);
  return markdown.trim();
}

/** Asserts the output and that loading it back gives the same Markdown. */
function assertSaves(editor, expected) {
  const markdown = markdownOf(editor);
  assert.equal(markdown, expected);
  assert.equal(markdownOf(createEditor(markdown)), markdown);
}

const pressKey = (editor, key, modifiers = {}) =>
  editor.view.someProp("handleKeyDown", (handler) =>
    handler(editor.view, new happyWindow.KeyboardEvent("keydown", { key, ...modifiers }))
  );

/** Types through the input rules, like a keyboard does. */
function type(editor, text) {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(char, from, to);
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, char, insert)
    );
    if (!handled) view.dispatch(insert());
  }
}

function paste(editor, { text = "", html = "" }) {
  const clipboardData = new happyWindow.DataTransfer();
  clipboardData.setData("text/plain", text);
  if (html) clipboardData.setData("text/html", html);
  editor.view.dom.dispatchEvent(new happyWindow.ClipboardEvent("paste", { clipboardData }));
}

/** Puts the caret `offset` characters into the cell whose text is `text`. */
function caretInCell(editor, text, offset = 0) {
  let target;
  editor.state.doc.descendants((node, pos) => {
    if (
      target === undefined &&
      node.type.spec.tableRole?.includes("cell") &&
      node.textContent === text
    ) {
      target = pos + 2 + offset;
    }
  });
  assert.notEqual(target, undefined, `no cell "${text}"`);
  editor.commands.setTextSelection(target);
}

const caretText = (editor) => {
  const { $head } = editor.state.selection;
  return `${$head.parent.textContent.slice(0, $head.parentOffset)}|${$head.parent.textContent.slice($head.parentOffset)} in ${$head.node(-1).type.name}`;
};

test("a GFM table loads and saves unchanged, between paragraphs and inside a list", () => {
  assertSaves(createEditor(`Before\n\n${TABLE}\n\nAfter`), `Before\n\n${TABLE}\n\nAfter`);
  const listed = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |";
  assertSaves(createEditor(listed), listed);
  assertSaves(createEditor("| A | B |\n| --- | --- |"), "| A | B |\n| --- | --- |");
});

test("ragged rows are padded and alignment is neither shown nor saved", () => {
  const editor = createEditor("| A | B | C |\n| :-- | :-: | --: |\n| 1 |\n| 1 | 2 | 3 | 4 |");
  assert.doesNotMatch(editor.getHTML(), /text-align/);
  assertSaves(editor, "| A | B | C |\n| --- | --- | --- |\n| 1 |  |  |\n| 1 | 2 | 3 |");
});

test("editing a cell keeps the table (#1948)", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Ana", 3);
  type(editor, "!");
  assertSaves(editor, TABLE.replace("Ana", "Ana!"));
});

test("pipes in a cell are escaped, including inside code", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Budget");
  type(editor, "a|b ");
  assertSaves(editor, TABLE.replace("Budget", "a\\|b Budget"));
  const code = "| A | B |\n| --- | --- |\n| `x\\|y` | z |";
  assertSaves(createEditor(code), code);
});

test("formatting after a pipe in the same cell survives saving", () => {
  for (const cell of [
    "x \\| y **b**",
    "x \\| y *i*",
    "x \\| y ~~s~~",
    "**a** \\| `c\\|d` [l](https://x.y)",
  ]) {
    const markdown = `| A \\| B **h** |\n| --- |\n| ${cell} |`;
    const editor = createEditor(markdown);
    caretInCell(editor, "A | B h");
    type(editor, "!");
    assertSaves(editor, markdown.replace("| A", "| !A"));
  }
});

test("cell text starting with a list or number marker is saved without escapes", () => {
  const markdown = "| A | B |\n| --- | --- |\n| -5% | 1. Plan |\n| + 3 | # tag |";
  const editor = createEditor(markdown);
  caretInCell(editor, "A", 1);
  type(editor, "!");
  assertSaves(editor, markdown.replace("| A |", "| A! |"));
});

test("Enter moves to the end of the cell below", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Budget", 3);
  assert.equal(pressKey(editor, "Enter"), true);
  assert.equal(caretText(editor), "Hiring| in tableCell");
  assertSaves(editor, TABLE);
});

test("Enter on the last row adds a row and moves into it", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Raj", 1);
  pressKey(editor, "Enter");
  type(editor, "new");
  assertSaves(editor, `${TABLE}\n|  | new |`);
});

test("Enter on an empty last row removes it and leaves the table", () => {
  const editor = createEditor(`${TABLE}\n\nAfter`);
  caretInCell(editor, "Raj", 3);
  pressKey(editor, "Enter");
  pressKey(editor, "Enter");
  assert.equal(caretText(editor), "| in doc");
  type(editor, "Next");
  assertSaves(editor, `${TABLE}\n\nNext\n\nAfter`);

  // An empty paragraph already below the table (here the trailing one) takes the caret instead.
  const trailing = createEditor(TABLE);
  caretInCell(trailing, "Raj", 3);
  pressKey(trailing, "Enter");
  assert.equal(trailing.state.doc.childCount, 2);
  pressKey(trailing, "Enter");
  assert.equal(trailing.state.doc.childCount, 2);
  assert.equal(caretText(trailing), "| in doc");
});

test("Enter in the header row of a header-only table adds a body row", () => {
  const editor = createEditor("| A | B |\n| --- | --- |");
  caretInCell(editor, "A", 1);
  pressKey(editor, "Enter");
  type(editor, "1");
  assertSaves(editor, "| A | B |\n| --- | --- |\n| 1 |  |");
});

test("Shift-Enter and Mod-Enter never put a line break in a cell", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Budget", 3);
  const mod = /Mac|iP(hone|[oa]d)/.test(happyWindow.navigator.platform)
    ? { metaKey: true }
    : { ctrlKey: true };
  assert.equal(pressKey(editor, "Enter", { shiftKey: true }), true);
  assert.equal(pressKey(editor, "Enter", mod), true);
  assertSaves(editor, TABLE);
});

test("Enter outside a table keeps its usual behavior", () => {
  const paragraph = createEditor("plain text");
  paragraph.commands.setTextSelection(11);
  pressKey(paragraph, "Enter");
  type(paragraph, "ok");
  assertSaves(paragraph, "plain text\n\nok");

  const list = createEditor("- a\n- b");
  list.commands.setTextSelection(4);
  pressKey(list, "Enter");
  type(list, "c");
  assertSaves(list, "- a\n- c\n- b");

  const code = createEditor("```\ncode\n```");
  code.commands.setTextSelection(5);
  pressKey(code, "Enter");
  type(code, "x");
  assertSaves(code, "```\ncode\nx\n```");

  const lineBreak = createEditor("line");
  lineBreak.commands.setTextSelection(5);
  pressKey(lineBreak, "Enter", { shiftKey: true });
  type(lineBreak, "two");
  assertSaves(lineBreak, "line\\\ntwo");
});

test("a typed header row turns into a table on Enter", () => {
  const editor = createEditor("Intro");
  editor.commands.setTextSelection(6);
  pressKey(editor, "Enter");
  type(editor, "| Item | Cost |");
  pressKey(editor, "Enter");
  assert.equal(caretText(editor), "| in tableCell");
  type(editor, "Pens");
  assertSaves(editor, "Intro\n\n| Item | Cost |\n| --- | --- |\n| Pens |  |");
});

test("undo after a typed header row gives back the typed line", () => {
  const editor = createEditor("Intro");
  editor.commands.setTextSelection(6);
  pressKey(editor, "Enter");
  type(editor, "| Item | Cost |");
  pressKey(editor, "Enter");
  editor.commands.undo();
  assertSaves(editor, "Intro\n\n| Item | Cost |");
});

test("a header row inside a list item stays text", () => {
  const editor = createEditor("- | a | b |");
  editor.commands.setTextSelection(Selection.atEnd(editor.state.doc).from);
  pressKey(editor, "Enter");
  let hasTable = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "table") hasTable = true;
  });
  assert.equal(hasTable, false);
});

test("block Markdown shortcuts typed at the start of a cell stay text", () => {
  // The same helper does trigger them outside a table.
  const outside = createEditor("");
  type(outside, "- x");
  assertSaves(outside, "- x");
  assert.equal(outside.state.doc.firstChild.type.name, "bulletList");
  const rule = createEditor("");
  type(rule, "---");
  assert.equal(rule.state.doc.firstChild.type.name, "horizontalRule");

  for (const shortcut of ["- ", "1. ", "# ", "> ", "[ ] ", "---"]) {
    const editor = createEditor("| A |\n| --- |\n| x |");
    caretInCell(editor, "x");
    type(editor, shortcut);
    let cellText;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "tableCell") cellText = node.textContent;
    });
    assert.equal(cellText, `${shortcut}x`, shortcut);
    markdownOf(editor);
  }
});

test("a pasted table without a header row gets one; line breaks become spaces", () => {
  const editor = createEditor("x");
  paste(editor, {
    html: "<table><tbody><tr><td><p>Q</p></td><td><p>Rev</p></td></tr><tr><td><p>Q1</p></td><td><p>10<br>est.</p></td></tr></tbody></table>",
  });
  assertSaves(editor, "| Q | Rev |\n| --- | --- |\n| Q1 | 10 est. |\n\nx");
});

test("pasted merged cells keep their columns aligned", () => {
  const editor = createEditor("x");
  paste(editor, {
    html: '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">wide</td><td>c</td></tr><tr><td rowspan="2">tall</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>',
  });
  assertSaves(
    editor,
    "| A | B | C |\n| --- | --- | --- |\n| wide |  | c |\n| tall | 1 | 2 |\n|  | 3 | 4 |\n\nx"
  );
});

test("pasted column widths are ignored and bold survives a line break", () => {
  const editor = createEditor("x");
  paste(editor, {
    html: '<table><colgroup><col width="420"><col width="80"></colgroup><tr><th>A</th><th>B</th></tr><tr><td><b>a<br>b</b></td><td>c</td></tr></table>',
  });
  assert.doesNotMatch(editor.getHTML(), /colwidth|420px/);
  assertSaves(editor, "| A | B |\n| --- | --- |\n| **a b** | c |\n\nx");
});

test("a pasted table with a short row is padded", () => {
  const editor = createEditor("x");
  paste(editor, {
    html: "<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>only</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>",
  });
  assertSaves(editor, "| A | B | C |\n| --- | --- | --- |\n| only |  |  |\n| 1 | 2 | 3 |\n\nx");
});

test("pasted cells holding blocks or a nested table are flattened to one line", () => {
  const editor = createEditor("x");
  paste(editor, {
    html: "<table><tr><th><h3>Topic</h3></th><th>Notes</th></tr><tr><td><p>one</p><p>two</p></td><td><ul><li>i1</li><li><b>i2</b></li></ul></td></tr><tr><td><pre>a\nb</pre></td><td><table><tr><td>nested</td><td>cells</td></tr></table></td></tr></table>",
  });
  assertSaves(
    editor,
    "| Topic | Notes |\n| --- | --- |\n| one two | i1 **i2** |\n| a b | nested cells |\n\nx"
  );
});

test("multi-line text pasted into a cell joins into one line and keeps the caret after it", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Budget", 2);
  paste(editor, { text: "line1\nline2" });
  assert.equal(caretText(editor), "Buline1 line2|dget in tableCell");
  paste(editor, { html: "<p>a<br>b</p><ul><li>c</li></ul>" });
  assertSaves(editor, TABLE.replace("Budget", "Buline1 line2a b cdget"));
});

test("several paragraphs pasted into a cell join into it without touching other cells", () => {
  for (const clipboard of [
    { text: "p1\n\np2" },
    { html: "<p>p1</p><p>p2</p>" },
    { html: "<div>p1</div><div>p2</div>" },
  ]) {
    const editor = createEditor(TABLE);
    caretInCell(editor, "Budget", 3);
    paste(editor, clipboard);
    assertSaves(editor, TABLE.replace("Budget", "Budp1 p2get"));
  }
  const plain = createEditor(TABLE);
  caretInCell(plain, "Budget", 3);
  plain.view.pasteText("p1\np2");
  assertSaves(plain, TABLE.replace("Budget", "Budp1 p2get"));
});

/** Selects every body cell of TABLE. */
function selectBodyCells(editor) {
  const cells = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") cells.push(pos);
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0], cells.at(-1)))
  );
}

test("several paragraphs pasted over selected cells go into each as one line", () => {
  const editor = createEditor(TABLE);
  selectBodyCells(editor);
  paste(editor, { text: "p1\n\np2" });
  assertSaves(editor, "| Name | Owner |\n| --- | --- |\n| p1 p2 | p1 p2 |\n| p1 p2 | p1 p2 |");
});

test("a paste with nothing to insert, such as a screenshot or a rule, leaves cells alone", () => {
  for (const clipboard of [{}, { text: "---" }, { html: "<hr>" }]) {
    const overCells = createEditor(TABLE);
    selectBodyCells(overCells);
    paste(overCells, clipboard);
    assertSaves(overCells, TABLE);

    const overText = createEditor(TABLE);
    caretInCell(overText, "Budget");
    overText.commands.setTextSelection({
      from: overText.state.selection.from,
      to: overText.state.selection.from + 3,
    });
    paste(overText, clipboard);
    assertSaves(overText, TABLE);
  }
});

test("a table followed by text, pasted into a cell, is flattened into it", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Ana", 3);
  paste(editor, { text: "| K | V |\n| --- | --- |\n| a | 1 |\n\nafter" });
  assertSaves(editor, TABLE.replace("Ana", "AnaK V a 1 after"));
});

test("two tables pasted into a cell are flattened into it", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Ana", 3);
  paste(editor, { text: "| K |\n| --- |\n| a |\n\n| L |\n| --- |\n| b |" });
  assertSaves(editor, TABLE.replace("Ana", "AnaK a L b"));
});

test("a table on its own pasted into a cell fills cells from the caret", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Ana");
  paste(editor, { html: "<table><tr><th>K</th></tr><tr><td>v</td></tr></table>" });
  assertSaves(editor, TABLE.replace("Ana", "K").replace("Raj", "v"));
});

test("a drop below a table lands the same whether or not the caret was in a cell", () => {
  const dropList = (placeCaret) => {
    const editor = createEditor(`${TABLE}\n\nEnd`);
    placeCaret(editor);
    editor.view.posAtCoords = () => ({ pos: editor.state.doc.content.size - 1, inside: -1 });
    const dataTransfer = new happyWindow.DataTransfer();
    dataTransfer.setData("text/html", "<ul><li>first</li><li>second</li></ul>");
    const drop = new happyWindow.DragEvent("drop", { bubbles: true, cancelable: true });
    // happy-dom ignores dataTransfer in the event init.
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    editor.view.dom.dispatchEvent(drop);
    return markdownOf(editor);
  };
  const fromCell = dropList((editor) => caretInCell(editor, "Ana", 1));
  assert.match(fromCell, /\n- second$/);
  assert.equal(
    fromCell,
    dropList((editor) => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
  );
});

test("a line break dropped into a cell becomes a space", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Budget", 3);
  editor.view.posAtCoords = () => ({ pos: editor.state.selection.from, inside: -1 });
  const dataTransfer = new happyWindow.DataTransfer();
  dataTransfer.setData("text/html", "<p>a<br>b</p>");
  const drop = new happyWindow.DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  editor.view.dom.dispatchEvent(drop);
  assertSaves(editor, TABLE.replace("Budget", "Buda bget"));
});

test("a Markdown table pasted as text becomes a table", () => {
  const editor = createEditor("");
  paste(editor, { text: "Header\n\n| K | V |\n| --- | --- |\n| a | 1 |" });
  assertSaves(editor, "Header\n\n| K | V |\n| --- | --- |\n| a | 1 |");
});

test("row and column commands keep a header row", () => {
  const above = createEditor(TABLE);
  caretInCell(above, "Name");
  above.commands.addRowBefore();
  assertSaves(
    above,
    "|  |  |\n| --- | --- |\n| Name | Owner |\n| Budget | Ana |\n| Hiring | Raj |"
  );

  const deleted = createEditor(TABLE);
  caretInCell(deleted, "Name");
  deleted.commands.deleteRow();
  assertSaves(deleted, "| Budget | Ana |\n| --- | --- |\n| Hiring | Raj |");

  const columns = createEditor(TABLE);
  caretInCell(columns, "Name");
  columns.commands.addColumnAfter();
  caretInCell(columns, "Ana");
  columns.commands.deleteColumn();
  assertSaves(columns, "| Name |  |\n| --- | --- |\n| Budget |  |\n| Hiring |  |");
});

test("copying cells puts a GFM table on the text clipboard", () => {
  const editor = createEditor(TABLE);
  const cells = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") cells.push(pos);
  });
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0], cells.at(-1)))
  );
  const serialize = (view) =>
    view.someProp("clipboardTextSerializer", (serializer) =>
      serializer(view.state.selection.content(), view)
    );
  assert.equal(serialize(editor.view).trim(), "| Budget | Ana |\n| --- | --- |\n| Hiring | Raj |");

  for (const nestedTable of [
    `- item\n\n  ${TABLE.replaceAll("\n", "\n  ")}`,
    `> ${TABLE.replaceAll("\n", "\n> ")}`,
  ]) {
    const nested = createEditor(nestedTable);
    caretInCell(nested, "Budget");
    nested.commands.setTextSelection({
      from: nested.state.selection.from,
      to: nested.state.selection.from + 3,
    });
    assert.equal(serialize(nested.view), "Bud", nestedTable);
  }

  // A triple-click selects the whole cell as a one-cell selection.
  const oneCell = createEditor(TABLE);
  caretInCell(oneCell, "Ana");
  oneCell.view.dispatch(
    oneCell.state.tr.setSelection(
      CellSelection.create(oneCell.state.doc, oneCell.state.selection.$from.before(-1))
    )
  );
  assert.equal(serialize(oneCell.view), "Ana");
  const emptyCell = createEditor("| A |\n| --- |\n|  |");
  let emptyPos;
  emptyCell.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") emptyPos = pos;
  });
  emptyCell.view.dispatch(
    emptyCell.state.tr.setSelection(CellSelection.create(emptyCell.state.doc, emptyPos))
  );
  assert.equal(serialize(emptyCell.view), " ");

  const inCell = createEditor(TABLE);
  caretInCell(inCell, "Budget");
  inCell.commands.setTextSelection({
    from: inCell.state.selection.from,
    to: inCell.state.selection.from + 3,
  });
  assert.equal(serialize(inCell.view), "Bud");

  const text = createEditor("**bold** text");
  text.commands.selectAll();
  assert.equal(serialize(text.view), "**bold** text");
});

test("undo reverts a change together with the header fix it caused", () => {
  const editor = createEditor(TABLE);
  caretInCell(editor, "Name");
  editor.commands.addRowBefore();
  assert.notEqual(markdownOf(editor), TABLE);
  editor.commands.undo();
  assert.equal(markdownOf(editor), TABLE);
});

/**
 * Renders the real RichTextEditor, table menu included, the way NoteEditor uses
 * it: the note is state, and switching notes remounts the editor.
 */
async function renderNotes(t, markdown = TABLE, caretCell = "Ana") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t);
  const { RichTextEditor } = await vite.ssrLoadModule("/components/ui/RichTextEditor.tsx");
  const errors = [];
  class Boundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      errors.push(error.message);
    }
    render() {
      return this.state.failed ? null : this.props.children;
    }
  }
  const editorRef = { current: null };
  let showOtherNote;
  function Note({ initial }) {
    const [value, setValue] = React.useState(initial);
    return React.createElement(RichTextEditor, {
      value,
      onChange: setValue,
      editorRef,
      mentionPeople: [],
    });
  }
  function Notes() {
    const [other, setOther] = React.useState(false);
    showOtherNote = () => setOther(true);
    return React.createElement(Note, {
      key: String(other),
      initial: other ? "Other note" : `Intro\n\n${markdown}\n\nAfter`,
    });
  }
  // happy-dom reports errors thrown in event listeners and timers on window,
  // where no error boundary sees them.
  const onWindowError = (event) => errors.push(event.error?.message ?? event.message);
  happyWindow.addEventListener("error", onWindowError);
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
    happyWindow.removeEventListener("error", onWindowError);
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  // Waits inside act for timers the editor and menu set, then again after it:
  // effects that React flushes when act ends (unmounts) set timers too.
  const act = async (callback) => {
    await React.act(async () => {
      await callback();
      await settle();
    });
    await settle();
  };
  await act(() => root.render(React.createElement(Boundary, null, React.createElement(Notes))));
  await act(() => {
    editorRef.current.commands.focus();
    caretInCell(editorRef.current, caretCell, 1);
  });
  // Without an i18next instance, t() returns the key.
  const trigger = happyWindow.document.querySelector('[aria-label="notes.editor.table.actions"]');
  await act(() =>
    trigger.dispatchEvent(
      new happyWindow.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      })
    )
  );
  const menuItem = (key) =>
    [...happyWindow.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === `notes.editor.table.${key}`
    );
  return { act, editorRef, errors, host, menuItem, showOtherNote: () => showOtherNote() };
}

test("Delete table from the menu works in a note that re-renders on every change", async (t) => {
  const { act, editorRef, errors, menuItem } = await renderNotes(t);
  await act(() => menuItem("deleteTable").click());
  assert.deepEqual(errors, []);
  assert.equal(markdownOf(editorRef.current), "Intro\n\nAfter");
});

test("the menu disables actions that would break or empty the table", async (t) => {
  const isDisabled = (item) => item.hasAttribute("data-disabled");
  const header = await renderNotes(t, "| A | B |\n| --- | --- |", "A");
  assert.equal(isDisabled(header.menuItem("insertRowAbove")), true);
  assert.equal(isDisabled(header.menuItem("deleteRow")), true);
  assert.equal(isDisabled(header.menuItem("deleteColumn")), false);
});

test("switching notes while the table menu is open", async (t) => {
  const { act, errors, host, menuItem, showOtherNote } = await renderNotes(t);
  assert.ok(menuItem("deleteTable"), "menu is open");
  await act(showOtherNote);
  assert.deepEqual(errors, []);
  assert.match(host.textContent, /Other note/);
});
