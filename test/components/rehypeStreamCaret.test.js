const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/rehypeStreamCaret.ts");

const text = (value) => ({ type: "text", value });
const element = (tagName, children, properties = {}) => ({
  type: "element",
  tagName,
  properties,
  children,
});
const root = (...children) => ({ type: "root", children });

const caretIn = (node) =>
  (node.children ?? []).filter(
    (child) => child.type === "element" && child.properties?.["data-stream-caret"] === "true"
  );

const apply = async (tree) => {
  const { rehypeStreamCaret } = await load();
  rehypeStreamCaret({ className: "assistant-stream-caret" })(tree);
  return tree;
};

// Josh, on the rig 2026-09-08: "A cursor hangs below the end of every
// sentence, almost like a line break." The caret was a <span> rendered as a
// SIBLING of the block-level markdown container, and an inline box after a
// block box always starts a new line. These tests pin where the caret lands
// for each shape a streaming reply can be cut off in.
test("a paragraph gets the caret inside it, after the last word", async () => {
  const tree = await apply(root(element("p", [text("Hello world")])));
  const paragraph = tree.children[0];
  assert.equal(caretIn(tree).length, 0, "the caret must not be left at the top level beside the block");
  assert.equal(caretIn(paragraph).length, 1, "the caret belongs inside the paragraph");
  assert.equal(
    paragraph.children[paragraph.children.length - 1].properties["data-stream-caret"],
    "true",
    "and at the very end of it, after the text"
  );
  assert.deepEqual(caretIn(paragraph)[0].properties.className, ["assistant-stream-caret"]);
  assert.equal(caretIn(paragraph)[0].properties["aria-hidden"], "true", "a caret is decoration, not content");
});

test("only the LAST block gets the caret", async () => {
  const tree = await apply(
    root(element("p", [text("First.")]), element("p", [text("Second, still writing")]))
  );
  assert.equal(caretIn(tree.children[0]).length, 0, "a finished paragraph must not keep a caret");
  assert.equal(caretIn(tree.children[1]).length, 1);
});

test("a list puts the caret in the last item's own text, not after the list", async () => {
  const tree = await apply(
    root(element("ul", [element("li", [text("one")]), element("li", [text("two")])]))
  );
  const list = tree.children[0];
  assert.equal(caretIn(list).length, 0, "not loose inside <ul>, which would render it on its own row");
  assert.equal(caretIn(list.children[0]).length, 0);
  assert.equal(caretIn(list.children[1]).length, 1, "the caret follows the text of the item being written");
});

test("a nested block inside a list item is descended into", async () => {
  const tree = await apply(root(element("ul", [element("li", [element("p", [text("deep")])])])));
  const paragraph = tree.children[0].children[0].children[0];
  assert.equal(paragraph.tagName, "p");
  assert.equal(caretIn(paragraph).length, 1);
});

test("a blockquote puts the caret with the quoted text", async () => {
  const tree = await apply(root(element("blockquote", [element("p", [text("quoted")])])));
  const quoted = tree.children[0].children[0];
  assert.equal(caretIn(quoted).length, 1);
});

// The caret must never be injected into code the model is writing — it would
// render as markup inside the user's code sample. Falling back to the top
// level puts it under the block, which is exactly where it sat before this
// plugin existed, so this case is no worse than the status quo.
test("a code block keeps the caret outside it, at the top level", async () => {
  const tree = await apply(root(element("pre", [element("code", [text("const x = 1;")])])));
  assert.equal(caretIn(tree).length, 1, "the caret goes after the block, not inside it");
  const pre = tree.children[0];
  assert.equal(caretIn(pre).length, 0);
  assert.equal(caretIn(pre.children[0]).length, 0, "never inside <code> itself");
  assert.match(JSON.stringify(pre), /const x = 1;/, "the code's own text must be untouched");
});

test("an empty tail is left completely alone, for the caller's fallback caret", async () => {
  const { findCaretHost } = await load();
  const tree = root();
  assert.equal(findCaretHost(tree), null);
  await apply(tree);
  assert.deepEqual(tree.children, [], "nothing to attach to means nothing is added");
});
