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

const delaysOf = (node) =>
  node.children
    .filter((n) => n.type === "element")
    .map((s) => Number(/animation-delay: (-?\d+)ms/.exec(s.properties.style)[1]));

// Fix round 1, findings 1+3: `firstNewWordIndex` (a single threshold number,
// recomputed from a raw-markdown word COUNT taken outside this module) was
// replaced by `risenWords`, a caller-owned Map<realIndex, delayMs> that this
// walk itself is the sole author of. These tests cover the sticky contract
// directly: a word already in the map must keep ITS OWN delay (never
// recomputed — recomputing is what silently cancelled an in-flight rise the
// instant the next token arrived).
test("reuses an already-risen word's own delay untouched, and assigns new words the next stagger slot", async () => {
  const { rehypeWordRise } = await load();
  const tree = { type: "root", children: [element("p", [text("hello big world")])] };
  // "hello" (index 0) already rose in an earlier render with SOME delay —
  // deliberately not 0 or a stagger multiple, so a recomputed value would be
  // easy to tell apart from a reused one.
  const risenWords = new Map([[0, 999]]);
  const clock = { nextRiseAt: 0 };
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: 1000, maxLagMs: 600 })(tree);

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
  assert.equal(
    spans[0].properties.style,
    "animation-delay: 999ms",
    "index 0's own delay must be reused, not recomputed"
  );
  assert.equal(spans[1].properties["data-rise"], "true");
  // A cursor left in the past anchors the batch at `now`, so the first new
  // word still starts immediately — the common case of a fresh reply.
  assert.deepEqual(delaysOf(tree.children[0]).slice(1), [0, 28]);
  assert.equal(risenWords.size, 3);
  assert.equal(risenWords.get(0), 999);
  // Whitespace survives as text between the spans.
  assert.equal(tree.children[0].children.filter((n) => n.type === "text").length, 2);
});

// THE REGRESSION TEST for Josh's 2026-09-08 rig feedback: the streaming
// "lacks a smooth effect flowing left to right and then down each line".
// A CSS animation-delay is measured from the paint that created the span, so
// two batches painted at different times cannot be ordered by their delays
// alone. The previous implementation restarted its stagger counter every
// walk, which put a LATER word's absolute rise BEFORE an earlier word's
// whenever chunks overlapped — a scatter, not a sweep. What must hold is a
// statement about absolute time: now + delay, strictly increasing in
// document order, across batch boundaries.
test("rise order is document order in ABSOLUTE time, across separate arrival batches", async () => {
  const { rehypeWordRise } = await load();
  const risenWords = new Map();
  const clock = { nextRiseAt: 0 };

  const firstAt = 1000;
  const first = { type: "root", children: [element("p", [text("Alpha Bravo Charlie")])] };
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: firstAt, maxLagMs: 600 })(first);
  const firstAbsolute = delaysOf(first.children[0]).map((d) => firstAt + d);
  assert.deepEqual(firstAbsolute, [1000, 1028, 1056]);

  // The next chunk lands 16ms later — long before the first batch has
  // finished rising. Delta and Echo are the only new words, and under the
  // old per-walk counter they took delays 0 and 28, i.e. absolute 1016 and
  // 1044: Delta rose BEFORE Bravo and Charlie, which had not started yet.
  const secondAt = 1016;
  const second = {
    type: "root",
    children: [element("p", [text("Alpha Bravo Charlie Delta Echo")])],
  };
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: secondAt, maxLagMs: 600 })(second);
  const secondAbsolute = delaysOf(second.children[0]).map((d) => secondAt + d);

  // The three sticky words keep the delays they were given in the first
  // batch, so their spans' style strings are unchanged and their in-flight
  // animations are not restarted.
  assert.deepEqual(secondAbsolute.slice(0, 3), [1016, 1044, 1072]);
  assert.deepEqual(
    second.children[0].children
      .filter((n) => n.type === "element")
      .slice(0, 3)
      .map((s) => s.properties.style),
    ["animation-delay: 0ms", "animation-delay: 28ms", "animation-delay: 56ms"]
  );

  // Delta and Echo are anchored AFTER Charlie's slot, not from zero.
  const absoluteStarts = [...firstAbsolute, secondAt + delaysOf(second.children[0])[3], secondAt + delaysOf(second.children[0])[4]];
  assert.deepEqual(absoluteStarts, [1000, 1028, 1056, 1084, 1112]);
  for (let i = 1; i < absoluteStarts.length; i++) {
    assert.ok(
      absoluteStarts[i] > absoluteStarts[i - 1],
      `word ${i} must begin rising strictly after word ${i - 1} (got ${absoluteStarts[i]} after ${absoluteStarts[i - 1]})`
    );
  }
});

// The bound that keeps the cursor above from running away. Without it a
// stream faster than one word per staggerMs grows an unbounded backlog and
// the reply keeps rising long after it has finished arriving.
test("a batch larger than the lag window shrinks its own stagger to fit, never past staggerMs", async () => {
  const { rehypeWordRise } = await load();
  const risenWords = new Map();
  const clock = { nextRiseAt: 0 };
  // 60 words in ONE walk — a near-instant reply, the worst case for backlog.
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const tree = { type: "root", children: [element("p", [text(words)])] };
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: 5000, maxLagMs: 600 })(tree);

  const delays = delaysOf(tree.children[0]);
  assert.equal(delays.length, 60);
  assert.equal(delays[0], 0, "the first word of a batch anchored at `now` still rises immediately");
  // 600 / 60 = 10ms, well under the 28ms ceiling.
  assert.deepEqual(delays.slice(0, 4), [0, 10, 20, 30]);
  assert.ok(
    delays[delays.length - 1] <= 600,
    `the cascade must fit the lag window (last delay was ${delays[delays.length - 1]}ms)`
  );
  // Strictly ordered end to end — a compressed cascade is still a cascade,
  // never a clump at the cap.
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] > delays[i - 1], `delay ${i} must exceed delay ${i - 1}`);
  }
  assert.equal(clock.nextRiseAt, 5600, "the cursor lands exactly at the window edge when saturated");
});

test("a walk that brings no new words leaves the cascade cursor alone", async () => {
  const { rehypeWordRise } = await load();
  const risenWords = new Map();
  const clock = { nextRiseAt: 0 };
  const build = () => ({ type: "root", children: [element("p", [text("one two")])] });

  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: 2000, maxLagMs: 600 })(build());
  const afterFirst = clock.nextRiseAt;
  assert.equal(afterFirst, 2056);

  // A re-render with identical content (React re-renders for unrelated
  // reasons all the time) must not push the cursor forward, or the next
  // genuinely new word would be delayed by a phantom batch.
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: 2010, maxLagMs: 600 })(build());
  assert.equal(clock.nextRiseAt, afterFirst);
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
  const clock = { nextRiseAt: 0 };
  rehypeWordRise({ risenWords, staggerMs: 28, clock, now: 0, maxLagMs: 600 })(tree);
  const indices = [];
  const walk = (node) => {
    if (node.type === "element" && node.tagName === "span") indices.push(node.properties["data-word-index"]);
    (node.children || []).forEach(walk);
  };
  walk(tree);
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(tree.children[1].children[0].children[0].value, "not words");
  // Code content was never indexed, so it never touched the map either — and
  // the read-only pre-pass that sizes the batch must skip it identically, or
  // the stagger would be computed from a word count the walk never assigns.
  assert.equal(risenWords.size, 4);
});
