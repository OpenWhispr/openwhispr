const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/streamingMarkdown.ts");

test("splits at the last paragraph boundary", async () => {
  const { splitStreamingMarkdown } = await load();
  assert.deepEqual(splitStreamingMarkdown("One.\n\nTwo.\n\nThr"), {
    settled: "One.\n\nTwo.\n\n",
    tail: "Thr",
  });
  assert.deepEqual(splitStreamingMarkdown("Only one block so far"), {
    settled: "",
    tail: "Only one block so far",
  });
  assert.deepEqual(splitStreamingMarkdown("Done.\n\n"), { settled: "Done.\n\n", tail: "" });
  assert.deepEqual(splitStreamingMarkdown(""), { settled: "", tail: "" });
});

test("counts whitespace-separated words", async () => {
  const { countWords } = await load();
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  hello   big\nworld "), 3);
});

// Fix round 1, finding 2: a boundary cutting inside a list, a fenced code
// block, or a blockquote produces genuinely WRONG rendered content, not
// just imperfect motion — the settled and tail halves are each parsed as
// independent documents (see test/components/streamingReplySettled.test.js
// for the rendered-output proof, against the real component: wrong list
// numbering, a code line rendered as a stray paragraph, tight/loose list
// reflow). None of these needs a full markdown parser to detect — only
// "does the block just before this boundary look like it might continue" —
// so an unsafe boundary defers to an earlier one instead of ever being
// taken.
test("defers the boundary while the settled candidate would end mid-list, and settles the WHOLE list once something after it proves the list is done", async () => {
  const { splitStreamingMarkdown } = await load();

  // Mid-list: only two ordered-list items exist so far, nothing follows —
  // every candidate boundary ends with a list item, so nothing is safe to
  // cut; nothing has been proven to settle. (No trailing "\n\n" here since
  // that reflects a still-streaming, mid-item token — the same shape the
  // existing "no boundary at all" case already covers, just for list text.)
  assert.deepEqual(splitStreamingMarkdown("1. First\n\n2. Second"), {
    settled: "",
    tail: "1. First\n\n2. Second",
  });

  // A THIRD item starts arriving — still mid-list, still nothing safe.
  assert.deepEqual(splitStreamingMarkdown("1. First\n\n2. Second\n\n3. Thi"), {
    settled: "",
    tail: "1. First\n\n2. Second\n\n3. Thi",
  });

  // Only once a genuinely NEW block (not itself list-shaped) follows does
  // the boundary become safe — and it settles the list as ONE unit (all
  // three items together), never splitting item 3 away from 1 and 2.
  assert.deepEqual(splitStreamingMarkdown("1. First\n\n2. Second\n\n3. Third\n\nAfter"), {
    settled: "1. First\n\n2. Second\n\n3. Third\n\n",
    tail: "After",
  });
});

test("defers the boundary for a bullet list the same way as an ordered list", async () => {
  const { splitStreamingMarkdown } = await load();
  assert.deepEqual(splitStreamingMarkdown("- First\n\n- Second"), {
    settled: "",
    tail: "- First\n\n- Second",
  });
  assert.deepEqual(splitStreamingMarkdown("- First\n\n- Second\n\nAfter"), {
    settled: "- First\n\n- Second\n\n",
    tail: "After",
  });
});

test("defers the boundary while the settled candidate would end mid-blockquote", async () => {
  const { splitStreamingMarkdown } = await load();
  assert.deepEqual(splitStreamingMarkdown("> Quoted one\n\n> Quoted two"), {
    settled: "",
    tail: "> Quoted one\n\n> Quoted two",
  });
  assert.deepEqual(splitStreamingMarkdown("> Quoted one\n\n> Quoted two\n\nAfter"), {
    settled: "> Quoted one\n\n> Quoted two\n\n",
    tail: "After",
  });
});

test("defers the boundary while a fenced code block is unterminated, even across a blank line inside it", async () => {
  const { splitStreamingMarkdown } = await load();
  // The fence's own blank line looks exactly like a paragraph boundary by
  // text alone; an unterminated (odd) fence count must still defer it.
  assert.deepEqual(splitStreamingMarkdown("Before.\n\n```js\ncode1\n\ncode2"), {
    settled: "Before.\n\n",
    tail: "```js\ncode1\n\ncode2",
  });
  // Once the fence closes, the boundary right after it is safe again.
  assert.deepEqual(splitStreamingMarkdown("Before.\n\n```js\ncode1\n\ncode2\n```\n\nAfter"), {
    settled: "Before.\n\n```js\ncode1\n\ncode2\n```\n\n",
    tail: "After",
  });
});

test("a boundary between two plain paragraphs is unaffected by the block-safety checks", async () => {
  const { splitStreamingMarkdown } = await load();
  assert.deepEqual(splitStreamingMarkdown("One.\n\nTwo.\n\nThr"), {
    settled: "One.\n\nTwo.\n\n",
    tail: "Thr",
  });
});
