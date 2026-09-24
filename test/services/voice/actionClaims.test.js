const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/actionClaims.ts");

test("flags a completed-action claim when no write succeeded this turn", async () => {
  const { findUnbackedActionClaim } = await load();
  assert.equal(
    findUnbackedActionClaim('I\'ve added "Kubernetes" to your dictionary.', []),
    "I've added"
  );
  assert.equal(findUnbackedActionClaim("I copied hello world to your clipboard.", []), "I copied");
  assert.equal(findUnbackedActionClaim("I have updated the note to Thursday.", []), "I have updated");
});

test("a successful write this turn backs the claim", async () => {
  const { findUnbackedActionClaim } = await load();
  assert.equal(findUnbackedActionClaim("I've added Kubernetes.", ["update_dictionary"]), null);
});

test("offers, questions and plain answers are not claims", async () => {
  const { findUnbackedActionClaim } = await load();
  for (const answer of [
    "I can add that to your dictionary. Should I?",
    "Would you like me to create a note?",
    "The capital of Australia is Canberra.",
    "I'll check the weather for you.",
  ]) {
    assert.equal(findUnbackedActionClaim(answer, []), null, answer);
  }
});
