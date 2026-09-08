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

// Fix round 1, findings 1+3: `firstNewWordIndex` (a single threshold number,
// recomputed from a raw-markdown word COUNT taken outside this module) was
// replaced by `risenWords`, a caller-owned Map<realIndex, delayMs> that this
// walk itself is the sole author of. These tests cover the sticky contract
// directly: a word already in the map must keep ITS OWN delay (never
// recomputed — recomputing is what silently cancelled an in-flight rise the
// instant the next token arrived), and a brand-new word's delay must be
// relative to how many OTHER new words arrived in THIS SAME call — not to
// risenWords.size, which is cumulative across the whole reply and would
// make a word arriving after 50 already-settled words wait 50 * staggerMs
// before it even starts (a real bug caught only by exercising a SECOND
// batch after the first has gone sticky, below).
test("reuses an already-risen word's own delay untouched, and assigns new words the next stagger slot", async () => {
  const { rehypeWordRise } = await load();
  const tree = { type: "root", children: [element("p", [text("hello big world")])] };
  // "hello" (index 0) already rose in an earlier render with SOME delay —
  // deliberately not 0 or a stagger multiple, so a recomputed value would be
  // easy to tell apart from a reused one.
  const risenWords = new Map([[0, 999]]);
  rehypeWordRise({ risenWords, staggerMs: 28 })(tree);

  const spans = tree.children[0].children.filter((n) => n.type === "element");
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => s.properties["data-word-index"]),
    [0, 1, 2]
  );
  // Every word carries data-rise now — sticky means "once risen, always
  // marked", specifically so a later render can never un-mark (and thereby
  // cancel) a word's animation.
  assert.equal(spans[0].properties["data-rise"], "true");
  assert.equal(spans[0].properties.style, "animation-delay: 999ms", "index 0's own delay must be reused, not recomputed to 0ms");
  assert.equal(spans[1].properties["data-rise"], "true");
  assert.equal(
    spans[1].properties.style,
    "animation-delay: 0ms",
    "the first NEW word in this call gets slot 0 — relative to this batch, not risenWords.size"
  );
  assert.equal(spans[2].properties.style, "animation-delay: 28ms", "the second NEW word in this call gets the next slot");
  // The caller's map is mutated in place with the two newly-seen words,
  // while index 0's original entry is untouched.
  assert.equal(risenWords.size, 3);
  assert.equal(risenWords.get(0), 999);
  assert.equal(risenWords.get(1), 0);
  assert.equal(risenWords.get(2), 28);
  // Whitespace survives as text between the spans.
  assert.equal(tree.children[0].children.filter((n) => n.type === "text").length, 2);
});

test("a later batch of new words staggers relative to ITSELF, not cumulatively from every word risen so far", async () => {
  const { rehypeWordRise } = await load();
  const risenWords = new Map();

  // First call: three words arrive together (a fresh batch from empty).
  const first = { type: "root", children: [element("p", [text("Alpha Bravo Charlie")])] };
  rehypeWordRise({ risenWords, staggerMs: 28 })(first);
  assert.deepEqual(
    first.children[0].children.filter((n) => n.type === "element").map((s) => s.properties.style),
    ["animation-delay: 0ms", "animation-delay: 28ms", "animation-delay: 56ms"]
  );

  // Second call: two MORE words join (a separate, later batch). Alpha/Bravo/
  // Charlie are sticky (already in the map) and must keep their exact
  // delays; Delta and Echo are the only genuinely new words THIS call, so
  // they must stagger from 0ms again — not continue at 84ms/112ms (which is
  // what risenWords.size — 3 already risen — would wrongly produce).
  const second = {
    type: "root",
    children: [element("p", [text("Alpha Bravo Charlie Delta Echo")])],
  };
  rehypeWordRise({ risenWords, staggerMs: 28 })(second);
  assert.deepEqual(
    second.children[0].children.filter((n) => n.type === "element").map((s) => s.properties.style),
    [
      "animation-delay: 0ms", // Alpha — sticky, unchanged
      "animation-delay: 28ms", // Bravo — sticky, unchanged
      "animation-delay: 56ms", // Charlie — sticky, unchanged
      "animation-delay: 0ms", // Delta — first new word THIS call
      "animation-delay: 28ms", // Echo — second new word THIS call
    ]
  );
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
  const risenWords = new Map();
  rehypeWordRise({ risenWords, staggerMs: 28 })(tree);
  const indices = [];
  const walk = (node) => {
    if (node.type === "element" && node.tagName === "span") indices.push(node.properties["data-word-index"]);
    (node.children || []).forEach(walk);
  };
  walk(tree);
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(tree.children[1].children[0].children[0].value, "not words");
  // Code content was never indexed, so it never touched the map either.
  assert.equal(risenWords.size, 4);
});
