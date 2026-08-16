const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/liveTranscriptPresentation.ts");

test("short live transcript keeps the whole active phrase shimmering", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("A short live phrase", 6), {
    settled: "",
    active: "A short live phrase",
  });
});

test("long live transcript shimmers only its trailing phrase", async () => {
  const { splitTranscriptForShimmer } = await load();
  const text = "one two three four five six seven eight nine ten";

  assert.deepEqual(splitTranscriptForShimmer(text, 4), {
    settled: "one two three four five six ",
    active: "seven eight nine ten",
  });
});

test("empty live transcript has no shimmer parts", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("   "), { settled: "", active: "" });
});

test("default shimmer work stays bounded to the newest six words", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("one two three four five six seven eight"), {
    settled: "one two ",
    active: "three four five six seven eight",
  });
});
