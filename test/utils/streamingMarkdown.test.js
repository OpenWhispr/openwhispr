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
