const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The note editor's blocks and marks beyond StarterKit (toggles, callouts,
// math, note links, colours, …) are stored as plain Markdown, because notes
// are saved with tiptap-markdown and html: false. Every fixture must reach a
// stable form after one save, and every block and mark must still be there
// after the note is reopened. Older builds save these forms as escaped text
// (\[\[Title\]\], \[!NOTE\]), which must read back the same.

const FIXTURES = path.join(__dirname, "../fixtures/richTextEditorBlocks");
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
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "HTMLInputElement",
  "ResizeObserver",
  "DOMRect",
];
// tiptap-markdown's placeholder for a node it can't write as Markdown.
const LOST_NODE =
  /\[(table|tableRow|tableHeader|tableCell|hardBreak|details|detailsSummary|detailsContent|callout|noteLink|tableOfContentsBlock|inlineMath|blockMath|youtube|twitch|emoji)\]/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+\S.*$/gm;

let win;
let Editor;
let createRichTextExtensions;
let createMentionExtension;

test.before(async () => {
  const { Window } = await import("happy-dom");
  win = new Window();
  const define = (n, v) =>
    Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true });
  define("window", win);
  for (const n of DOM_GLOBALS) define(n, win[n]);
  for (const n of ["requestAnimationFrame", "cancelAnimationFrame"]) define(n, win[n].bind(win));
  ({ createRichTextExtensions } =
    await import("../../src/components/ui/RichTextEditorExtensions.ts"));
  ({ createMentionExtension } = await import("../../src/components/ui/RichTextEditorMention.tsx"));
  // Same CommonJS build the extensions load, so ProseMirror stays one instance.
  ({ Editor } = require("@tiptap/core"));
});

test.after(async () => {
  await win.happyDOM.close();
});

const editorFor = (markdown) =>
  new Editor({
    element: win.document.createElement("div"),
    extensions: [createMentionExtension(() => []), ...createRichTextExtensions("")],
    content: markdown,
  });

function save(markdown) {
  const editor = editorFor(markdown);
  try {
    const md = editor.storage.markdown.getMarkdown();
    assert.doesNotMatch(md, LOST_NODE, "a node was written as a [placeholder]");
    return md.trim();
  } finally {
    editor.destroy();
  }
}

/** Node and mark types the editor builds from some Markdown. */
function featuresOf(markdown) {
  const editor = editorFor(markdown);
  try {
    const found = new Set();
    editor.state.doc.descendants((node) => {
      found.add(node.type.name);
      node.marks.forEach((m) => found.add(`mark:${m.type.name}`));
      if (node.attrs?.textAlign && node.attrs.textAlign !== "left")
        found.add(`align:${node.attrs.textAlign}`);
    });
    return [...found].sort();
  } finally {
    editor.destroy();
  }
}

// Compared without Markdown escape backslashes: \[\[Plan\]\] and [[Plan]] are the same line.
const checkboxes = (md) =>
  (md.match(CHECKBOX) || []).map((l) => l.trim().replace(/\\([`*\\~[\]_])/g, "$1"));

const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => [f, fs.readFileSync(path.join(FIXTURES, f), "utf8")]);

for (const [name, source] of fixtures) {
  test(`${name}: one save reaches a stable form that keeps every block and mark`, () => {
    const once = save(source);
    assert.equal(save(once), once, "saving again changed the note");
    assert.deepEqual(featuresOf(once), featuresOf(source), "a block or mark was lost");
    assert.deepEqual(checkboxes(once), checkboxes(source), "task lines changed");
  });
}

test("every editor block and mark is recognized", () => {
  const found = featuresOf(fs.readFileSync(path.join(FIXTURES, "all-features.md"), "utf8"));
  for (const f of [
    "blockMath",
    "callout",
    "codeBlock",
    "inlineMath",
    "tableOfContentsBlock",
    "youtube",
    "mark:highlight",
    "mark:rubyText",
    "mark:subscript",
    "mark:superscript",
    "mark:textStyle",
    "align:center",
  ]) {
    assert.ok(found.includes(f), `missing ${f}`);
  }
  assert.ok(
    featuresOf(fs.readFileSync(path.join(FIXTURES, "toggle-nested.md"), "utf8")).includes("details")
  );
  assert.ok(
    featuresOf(fs.readFileSync(path.join(FIXTURES, "note-links.md"), "utf8")).includes("noteLink")
  );
});

test("escaped markers inside code are left exactly as written", () => {
  const out = save(fs.readFileSync(path.join(FIXTURES, "audit-edge.md"), "utf8"));
  assert.ok(
    out.includes("\\[\\[not a link\\]\\] and \\[TOC\\] and \\[!NOTE\\]"),
    "code block changed"
  );
  assert.ok(out.includes("`\\[\\[code\\]\\]`"), "code span changed");
});

test("escaped forms (\\[\\[Title\\]\\], \\[!NOTE\\], \\[TOC\\]) read as links, callouts and contents", () => {
  const found = featuresOf(fs.readFileSync(path.join(FIXTURES, "audit-edge.md"), "utf8"));
  for (const f of ["callout", "tableOfContentsBlock", "noteLink"])
    assert.ok(found.includes(f), `missing ${f}`);
});

test("a highlight opener in one paragraph does not leak into the next", () => {
  assert.match(save("a ==b `==` c\n\nNext ==x== here"), /Next ==x== here/);
});

test("alignment is never written inside a table cell", () => {
  const editor = editorFor("| A | B |\n| --- | --- |\n| one | two |");
  try {
    let cell = null;
    editor.state.doc.descendants((node, pos) => {
      if (cell === null && node.type.name === "paragraph" && node.textContent === "one") cell = pos;
    });
    editor
      .chain()
      .setTextSelection(cell + 1)
      .setTextAlign("center")
      .run();
    assert.doesNotMatch(editor.storage.markdown.getMarkdown(), /\{align:/);
  } finally {
    editor.destroy();
  }
});

test("notes without the new forms keep the editor's existing Markdown", () => {
  // The form the editor already wrote before these extensions (task items are
  // separated by a blank line), so stored notes don't change on the next save.
  const plain =
    "# Weekly sync\n\nSome **bold** and *italic* text.\n\n- [ ] Ship it\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(save(plain), plain);
});

test("the find panel mounts before the editor view does (no early editor.view access)", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const { FindReplacePanel, WordCount } =
    await import("../../src/components/ui/editorBlocks/FindReplacePanel.tsx");
  // element: null leaves the editor unmounted, as React's first effects see it.
  const editor = new Editor({
    element: null,
    extensions: [createMentionExtension(() => []), ...createRichTextExtensions("")],
    content: "Hello",
  });
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(FindReplacePanel, { editor }),
          React.createElement(WordCount, { editor })
        )
      );
    });
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
    editor.destroy();
  }
});
