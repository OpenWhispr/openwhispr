const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/targetResolution.js");

const eng = { id: "C1", label: "#eng", names: ["eng"] };
const engBackend = { id: "C2", label: "#eng-backend", names: ["eng-backend"] };
const gabe = { id: "U1", label: "Gabe Smith", names: ["gabe", "Gabe Smith"] };
const gabriel = { id: "U2", label: "Gabriel Stone", names: ["gstone", "Gabriel Stone"] };
const zoe = { id: "U3", label: "Zoë Adams", names: ["zoe", "Zoë Adams"] };

test("an exact name wins over a longer one that starts the same", async () => {
  const { resolveTarget } = await load();
  assert.deepEqual(resolveTarget("eng", [engBackend, eng]), { status: "match", candidate: eng });
});

test("case, accents, spaces and punctuation don't matter", async () => {
  const { resolveTarget } = await load();
  assert.equal(resolveTarget("Eng Backend", [eng, engBackend]).candidate, engBackend);
  assert.equal(resolveTarget("zoe adams", [zoe, gabe]).candidate, zoe);
  assert.equal(resolveTarget("GABE SMITH", [gabe, gabriel]).candidate, gabe);
});

test("two prefix matches are ambiguous, never guessed", async () => {
  const { resolveTarget } = await load();
  assert.deepEqual(resolveTarget("gab", [gabe, gabriel]), {
    status: "ambiguous",
    candidates: [gabe, gabriel],
  });
});

test("a channel and a person with the same name are ambiguous", async () => {
  const { resolveTarget } = await load();
  const channel = { id: "C9", label: "#design", names: ["design"] };
  const person = { id: "U9", label: "Design Team", names: ["design", "Design Team"] };
  assert.equal(resolveTarget("design", [channel, person]).status, "ambiguous");
});

test("one candidate matched through two of its names counts once", async () => {
  const { resolveTarget } = await load();
  const twice = { id: "U4", label: "Sam", names: ["sam", "Sam"] };
  assert.deepEqual(resolveTarget("SAM", [twice]), { status: "match", candidate: twice });
});

test("exactOnly accepts only a character-for-character name", async () => {
  const { resolveTarget } = await load();
  assert.deepEqual(resolveTarget("eng", [eng], { exactOnly: true }), {
    status: "match",
    candidate: eng,
  });
  assert.deepEqual(resolveTarget("eng", [engBackend], { exactOnly: true }), { status: "none" });
  assert.deepEqual(resolveTarget("Eng", [eng], { exactOnly: true }), { status: "none" });
});

test("no match, or a query of punctuation only, is none", async () => {
  const { resolveTarget } = await load();
  assert.deepEqual(resolveTarget("ops", [eng, gabe]), { status: "none" });
  assert.deepEqual(resolveTarget("#!", [eng]), { status: "none" });
  assert.deepEqual(resolveTarget("", [eng]), { status: "none" });
});

test("an ambiguous result lists at most five candidates", async () => {
  const { resolveTarget, MAX_CANDIDATES } = await load();
  const teams = Array.from({ length: 7 }, (_, index) => ({
    id: `C${index}`,
    label: `#team-${index}`,
    names: [`team-${index}`],
  }));
  const result = resolveTarget("team", teams);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, MAX_CANDIDATES);
});
