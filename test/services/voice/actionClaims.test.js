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

test("matches hedged claims (just, already, also, now, successfully, gone ahead and)", async () => {
  const { findUnbackedActionClaim } = await load();
  assert.equal(findUnbackedActionClaim("I've just added Kubernetes.", []), "I've just added");
  assert.equal(
    findUnbackedActionClaim("I've already updated the note.", []),
    "I've already updated"
  );
  assert.equal(
    findUnbackedActionClaim("I've gone ahead and added that.", []),
    "I've gone ahead and added"
  );
  assert.equal(findUnbackedActionClaim("Sure, I've copied it.", []), "I've copied");
  assert.equal(
    findUnbackedActionClaim("Done! I added it to your dictionary.", []),
    "I added"
  );
});

test("a successful write this turn backs the claim", async () => {
  const { findUnbackedActionClaim } = await load();
  assert.equal(findUnbackedActionClaim("I've added Kubernetes.", ["update_dictionary"]), null);
});

test("excludes made-sure conditionals and other non-claims", async () => {
  const { findUnbackedActionClaim } = await load();
  for (const answer of [
    "I made sure to check your calendar.",
    "If I've updated the note, will it sync?",
    "Should I add it? I can add that for you.",
    "I can add that to your dictionary. Should I?",
    "Would you like me to create a note?",
    "The capital of Australia is Canberra.",
    "I'll check the weather for you.",
  ]) {
    assert.equal(findUnbackedActionClaim(answer, []), null, answer);
  }
});
