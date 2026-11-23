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
  /\[(table|tableRow|tableHeader|tableCell|hardBreak|details|detailsSummary|detailsContent|callout|noteLink|tableOfContentsBlock|inlineMath|blockMath|emoji)\]/;
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
  assert.equal(save("a ==b `==` c\n\nNext ==x== here"), "a ==b `==` c\n\nNext ==x== here");
});

test("text that only looks like the new forms keeps its meaning", () => {
  for (const text of ["x==y and y==z", "x ==1 and y ==2"]) assert.equal(save(text), text);
  assert.ok(featuresOf("foo==bar baz== qux").includes("mark:highlight"), "mid-word highlight");
  assert.ok(featuresOf("==a \\` b==").includes("mark:highlight"), "escaped backtick");
  // A $ or {sub} whose only close is inside a code span.
  for (const code of ["Set $HOME and `$PATH` first", "Use {sub}x in `{/sub}` docs"])
    assert.equal(save(code), code);
  for (const citation of ["[[1]](https://example.com)", "[\\[1\\]](https://example.com)"]) {
    const found = featuresOf(citation);
    assert.ok(found.includes("mark:link") && !found.includes("noteLink"), citation);
  }
});

test("pasted colours and fonts are not kept", () => {
  const editor = editorFor("");
  try {
    editor.view.pasteHTML(
      '<p><span style="color: rgb(31, 35, 40); font-family: -apple-system, &quot;Segoe UI&quot;">Pasted</span></p>'
    );
    assert.equal(editor.storage.markdown.getMarkdown(), "Pasted");
  } finally {
    editor.destroy();
  }
});

test("an empty line that inherits alignment saves without a marker", () => {
  const editor = editorFor("Title line {align:center}");
  try {
    editor
      .chain()
      .setTextSelection(editor.state.doc.content.size - 1)
      .splitBlock()
      .run();
    assert.equal(editor.storage.markdown.getMarkdown().trim(), "Title line {align:center}");
  } finally {
    editor.destroy();
  }
});

test("clicking a formula opens its editor", () => {
  const editor = editorFor("Formula $x^2$ here");
  try {
    editor.view.dom.querySelector(".tiptap-mathematics-render").click();
    assert.ok(win.document.querySelector(".rte-inline-input"), "math editor did not open");
  } finally {
    win.document.querySelector(".rte-inline-input")?.remove();
    editor.destroy();
  }
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

test("a ::: line in a code block does not close the toggle around it", () => {
  const toggle = ":::toggle Snippet\n\n```\n:::note\nText\n:::\n```\n\nAfter\n\n:::";
  assert.equal(save(toggle), toggle);
});

test("a toggle inside a list item reopens as a toggle", () => {
  const list = "- Header\n\n  :::toggle Steps\n\n  two\n\n  :::";
  assert.equal(save(list), list);
  assert.ok(featuresOf(list).includes("details"));
});

test("a toggle title an older build saved escaped reads back as typed", () => {
  const escaped = ":::toggle See \\[\\[Plan\\]\\]\n\nbody\n\n:::";
  const editor = editorFor(escaped);
  try {
    assert.equal(editor.state.doc.firstChild.firstChild.textContent, "See [[Plan]]");
    assert.equal(editor.storage.markdown.getMarkdown(), escaped);
  } finally {
    editor.destroy();
  }
});

test("< and > an older build saved as &lt; and &gt; read back as typed", () => {
  const editor = editorFor("$x &gt; 0$ see [[A -&gt; B]]");
  try {
    const found = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "inlineMath") found.push(node.attrs.latex);
      if (node.type.name === "noteLink") found.push(node.attrs.title);
    });
    assert.deepEqual(found, ["x > 0", "A -> B"]);
  } finally {
    editor.destroy();
  }
});

test("a callout that starts with a divider reopens as a callout", () => {
  const editor = editorFor("Intro");
  try {
    editor.chain().focus("end").splitBlock().setCallout("warning").run();
    editor.chain().setHorizontalRule().insertContent("Careful").run();
    const found = featuresOf(editor.storage.markdown.getMarkdown());
    assert.ok(found.includes("callout") && found.includes("horizontalRule"), found.join());
    assert.ok(!found.includes("heading"), "the marker became a heading");
  } finally {
    editor.destroy();
  }
});

test("an aligned list item keeps its alignment, and the list stays tight", () => {
  const list = "- one\n- two {align:center}\n- three";
  assert.equal(save(list), list);
  assert.ok(featuresOf(list).includes("align:center"));
});

test("a list item whose text is $$…$$ stays in its list", () => {
  for (const list of ["- a\n- $$x^2$$\n- c", "- [ ] $$y$$"]) assert.equal(save(list), list);
});

test("a formula containing $ reopens unchanged", () => {
  for (const latex of ["a$b", "\\$5"]) {
    const editor = editorFor("Cost ");
    editor.chain().setTextSelection(6).insertInlineMath({ latex }).run();
    const reopened = editorFor(editor.storage.markdown.getMarkdown());
    try {
      const formulas = [];
      reopened.state.doc.descendants((node) => {
        if (node.type.name === "inlineMath") formulas.push(node.attrs.latex);
      });
      assert.deepEqual(formulas, [latex]);
    } finally {
      editor.destroy();
      reopened.destroy();
    }
  }
});

test("an emoji renders as text, never as an image from a CDN", () => {
  const editor = editorFor("Hi");
  try {
    editor.chain().setTextSelection(3).setEmoji("rocket").run();
    assert.equal(editor.view.dom.querySelector("img"), null);
    assert.equal(editor.storage.markdown.getMarkdown(), "Hi🚀");
  } finally {
    editor.destroy();
  }
});

test("typing beside an emoji in a code span or link keeps the span", () => {
  for (const source of ["Run `echo 🚀 done` now", "[🚀 launch](https://example.com)"]) {
    const editor = editorFor(source);
    try {
      let at = null;
      editor.state.doc.descendants((node, pos) => {
        if (at === null && node.isText && node.text.includes("🚀"))
          at = pos + node.text.indexOf("🚀");
      });
      editor.commands.insertContentAt(at, "x");
      assert.equal(editor.storage.markdown.getMarkdown(), source.replace("🚀", "x🚀"));
    } finally {
      editor.destroy();
    }
  }
});

test("a [[…]] longer than a note title keeps every character", () => {
  const long = "a".repeat(250);
  assert.ok(save(`[[${long}]]`).includes(long));
});

test("notes without the new forms keep the editor's existing Markdown", () => {
  // The form the editor already wrote before these extensions (task items are
  // separated by a blank line), so stored notes don't change on the next save.
  const plain =
    "# Weekly sync\n\nSome **bold** and *italic* text.\n\n- [ ] Ship it\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.equal(save(plain), plain);
});

test("the find panel mounts before the editor view does and unmounts after it is destroyed", async () => {
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
    // useEditor can hand the panel an editor it already destroyed.
    editor.destroy();
    await React.act(async () => root.unmount());
    host.remove();
  }
});
