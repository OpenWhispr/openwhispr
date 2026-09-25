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

// R13: reading back a first-person note is not the assistant claiming the action.
test("ignores the user's own words read back from a note or snippet", async () => {
  const { findUnbackedActionClaim } = await load();
  for (const answer of [
    "Your standup note says: I finished the report, I updated the tests, and I fixed the build.",
    "Here's your snippet: I made the changes you asked for.",
    'The note reads "I added the tests."',
    "Your note reads “I created the draft, I saved it.”",
    "It says 'I moved the meeting to Friday.' Want me to read the rest?",
    'Your note, word for word: "I\'ve already updated the doc."',
  ]) {
    assert.equal(findUnbackedActionClaim(answer, []), null, answer);
  }
});

test("apostrophes and quoted names do not hide a real claim", async () => {
  const { findUnbackedActionClaim } = await load();
  assert.equal(
    findUnbackedActionClaim("I've updated the note called 'Standup'.", []),
    "I've updated"
  );
  assert.equal(
    findUnbackedActionClaim('Your note says "hi". I\'ve added a reply.', []),
    "I've added"
  );
  assert.equal(findUnbackedActionClaim("At 3:30 today. I saved it.", []), "I saved");
});
