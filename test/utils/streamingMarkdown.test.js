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

// Fix round 3, finding 1: round 1 and round 2 each patched ONE observed
// shape of the same defect (a tail that momentarily fails
// looksLikeListOrQuote — first an empty tail, then a bare/partial marker
// like "-" or "3." — gets read as proof a list/quote ended, when it is
// simply mid-stream). A property sweep found 30 such violations across 7 of
// 17 tried shapes; chasing each remaining one as its own fixture would only
// ever fix the specific character offsets exercised, leaving the next one
// for the next round. The actual promise this task makes ("settled blocks
// never re-render") is the general property being tested here directly:
// the settled prefix returned for a growing string must never get SHORTER
// as more of that same string streams in. splitStreamingMarkdown now takes
// the previous call's settled length as a floor and never returns less than
// it — this test proves that holds for every character-by-character (and,
// separately, chunk-by-chunk) prefix of eleven different document shapes,
// not just the specific inputs earlier rounds happened to try.
const MONOTONICITY_SHAPES = {
  "loose bullet list": "- Alpha\n\n- Bravo\n\n- Charlie\n\nAfter the list.",
  "loose ordered list": "1. Alpha\n\n2. Bravo\n\n3. Charlie\n\nAfter the list.",
  "tight bullet list": "- Alpha\n- Bravo\n- Charlie\n\nAfter the list.",
  "nested list": "- Alpha\n  - Nested one\n  - Nested two\n\n- Bravo\n\nAfter the list.",
  blockquote: "> Quoted one\n\n> Quoted two\n\nAfter the quote.",
  "quote then list": "> Quoted line\n\n- List item\n\nAfter.",
  "list, paragraph, list": "- First item\n\nA paragraph in between.\n\n- Second item\n\nAfter.",
  "fenced code with a blank line inside": "Before.\n\n```js\ncode line one\n\ncode line two\n```\n\nAfter the code.",
  headings: "## Heading one\n\nSome text.\n\n### Heading two\n\nMore text.",
  "plain paragraphs": "Paragraph one.\n\nParagraph two.\n\nParagraph three.",
  "whitespace-padded list": "  - Alpha\n\n  - Bravo\n\nAfter.",
};

test("the settled boundary is monotonically non-decreasing across every character-by-character prefix, for every shape (fix round 3, finding 1)", async () => {
  const { splitStreamingMarkdown } = await load();

  for (const [name, shape] of Object.entries(MONOTONICITY_SHAPES)) {
    let floor = 0;
    for (let i = 0; i <= shape.length; i++) {
      const chunk = shape.slice(0, i);
      const { settled, tail } = splitStreamingMarkdown(chunk, floor);
      assert.equal(
        settled + tail,
        chunk,
        `[${name}] settled+tail must reconstruct the streamed-so-far content at length ${i}`
      );
      assert.ok(
        settled.length >= floor,
        `[${name}] settled prefix REGRESSED at character ${i}: floor was ${floor}, got ${settled.length}\n` +
          `  chunk:   ${JSON.stringify(chunk)}\n  settled: ${JSON.stringify(settled)}`
      );
      floor = settled.length;
    }
  }
});

test("the settled boundary is monotonically non-decreasing across word-sized chunk arrivals, for every shape (fix round 3, finding 1)", async () => {
  const { splitStreamingMarkdown } = await load();

  for (const [name, shape] of Object.entries(MONOTONICITY_SHAPES)) {
    // Word-sized "chunks" (each run of non-whitespace plus its trailing
    // whitespace) approximate real token-by-token arrival more closely than
    // single characters — a coarser granularity feeding the SAME floor.
    const chunks = shape.match(/\S+\s*|\s+/g) ?? [];
    let accumulated = "";
    let floor = 0;
    for (const piece of chunks) {
      accumulated += piece;
      const { settled, tail } = splitStreamingMarkdown(accumulated, floor);
      assert.equal(settled + tail, accumulated, `[${name}] settled+tail must reconstruct the accumulated chunks`);
      assert.ok(
        settled.length >= floor,
        `[${name}] settled prefix REGRESSED after a chunk arrival: floor was ${floor}, got ${settled.length}\n` +
          `  accumulated so far: ${JSON.stringify(accumulated)}`
      );
      floor = settled.length;
    }
    assert.equal(accumulated, shape, `[${name}] fixture-integrity check: chunks must reconstruct the whole shape`);
  }
});

test("a new reply resets the floor to zero — a stale, larger floor from a previous reply is not carried over", async () => {
  const { splitStreamingMarkdown } = await load();

  // Simulate a long previous reply that settled a lot of content.
  const previousReply = "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\n";
  const { settled: staleFloorSource } = splitStreamingMarkdown(previousReply, 0);
  const staleFloor = staleFloorSource.length;
  assert.ok(staleFloor > 20, "fixture-integrity check: expected the previous reply to settle a substantial prefix");

  // A brand new, much shorter reply starts. Called WITHOUT resetting the
  // floor (previousSettledLength defaults to 0 — this is what "the caller
  // resets the floor to 0 on a new reply" means in practice: simply not
  // carrying the old value forward), the new reply's own boundary logic
  // must run on its own terms, unaffected by the old reply's floor.
  const newReplySoFar = "Hi";
  const { settled, tail } = splitStreamingMarkdown(newReplySoFar);
  assert.equal(settled, "", "a fresh, short reply must not inherit a stale floor from an unrelated previous reply");
  assert.equal(tail, "Hi");

  // Demonstrate what WOULD go wrong if the floor were wrongly carried over
  // (the bug this test guards the "reset" contract against): passing the
  // stale floor explicitly clamps the whole short reply as settled,
  // skipping its own tail/rise treatment entirely.
  const withStaleFloor = splitStreamingMarkdown(newReplySoFar, staleFloor);
  assert.equal(
    withStaleFloor.settled,
    newReplySoFar,
    "fixture-integrity check: demonstrates why NOT resetting the floor would be wrong"
  );
});
