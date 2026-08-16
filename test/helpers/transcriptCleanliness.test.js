const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptCleanliness.js");

test("flags a transcript with repetitions and multiple fillers", async () => {
  const { looksUncleaned } = await load();

  assert.equal(
    looksUncleaned(
      "Bueno eh quería decirte que las las cosas salieron o sea más o menos, eh, viste"
    ),
    true
  );
});

test("flags a transcript on an immediate word repetition alone", async () => {
  const { looksUncleaned } = await load();

  assert.equal(looksUncleaned("quería que las las cosas salieran bien"), true);
});

test("flags a transcript on two or more fillers alone", async () => {
  const { looksUncleaned } = await load();

  assert.equal(looksUncleaned("eh, quería decirte, o sea, que salió bien"), true);
});

test("accepts a clean transcript", async () => {
  const { looksUncleaned } = await load();

  assert.equal(looksUncleaned("Quería decirte que las cosas salieron más o menos bien."), false);
});

test("a single legitimate connective 'o sea' does not trigger", async () => {
  const { looksUncleaned } = await load();

  assert.equal(looksUncleaned("No vino, o sea que arrancamos sin él."), false);
});

test("empty and non-string input never triggers", async () => {
  const { looksUncleaned } = await load();

  assert.equal(looksUncleaned(""), false);
  assert.equal(looksUncleaned(null), false);
  assert.equal(looksUncleaned(undefined), false);
  assert.equal(looksUncleaned(42), false);
});

test("escalation targets the stronger sibling only for Gemini Lite models", async () => {
  const { cleanupEscalationModel } = await load();

  assert.equal(cleanupEscalationModel("gemini-3.5-flash-lite"), "gemini-3-flash-preview");
  assert.equal(cleanupEscalationModel("gemini-2.5-flash-lite"), "gemini-3-flash-preview");
  assert.equal(cleanupEscalationModel("gemini-3-flash-preview"), null);
  assert.equal(cleanupEscalationModel("gpt-4o-mini"), null);
  assert.equal(cleanupEscalationModel(null), null);
  assert.equal(cleanupEscalationModel(undefined), null);
});
