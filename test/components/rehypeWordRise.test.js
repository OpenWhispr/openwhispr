const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/rehypeWordRise.ts");

const text = (value) => ({ type: "text", value });
const element = (tagName, children, properties = {}) => ({
  type: "element",
  tagName,
  properties,
  children,
});

test("wraps each word in a span, animating only words at or after the first new index", async () => {
  const { rehypeWordRise } = await load();
  const tree = { type: "root", children: [element("p", [text("hello big world")])] };
  rehypeWordRise({ firstNewWordIndex: 1, staggerMs: 28 })(tree);

  const spans = tree.children[0].children.filter((n) => n.type === "element");
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => s.properties["data-word-index"]),
    [0, 1, 2]
  );
  assert.equal(spans[0].properties["data-rise"], undefined);
  assert.equal(spans[1].properties["data-rise"], "true");
  assert.equal(spans[1].properties.style, "animation-delay: 0ms");
  assert.equal(spans[2].properties.style, "animation-delay: 28ms");
  // Whitespace survives as text between the spans.
  assert.equal(tree.children[0].children.filter((n) => n.type === "text").length, 2);
});

test("word indices run across elements in document order and skip code", async () => {
  const { rehypeWordRise } = await load();
  const tree = {
    type: "root",
    children: [
      element("p", [text("a "), element("strong", [text("b c")]), text(" d")]),
      element("pre", [element("code", [text("not words")])]),
    ],
  };
  rehypeWordRise({ firstNewWordIndex: 0, staggerMs: 28 })(tree);
  const indices = [];
  const walk = (node) => {
    if (node.type === "element" && node.tagName === "span") indices.push(node.properties["data-word-index"]);
    (node.children || []).forEach(walk);
  };
  walk(tree);
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(tree.children[1].children[0].children[0].value, "not words");
});
