const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/spokenDates.ts");

test("an English reply's short month and weekday names are said in full", async () => {
  const { spellOutDates } = await load();
  const said = (text) => spellOutDates(text, "en");
  assert.equal(
    said("Your next meeting is on Wed, Nov 19 at 3:00 PM."),
    "Your next meeting is on Wednesday, November 19 at 3 PM."
  );
  assert.equal(said("It's due Sept. 3, 2026."), "It's due September 3, 2026.");
  assert.equal(said("Standup runs Mon to Fri."), "Standup runs Monday to Friday.");
  assert.equal(said("Lunch is Thu, Jan 8 at noon."), "Lunch is Thursday, January 8 at noon.");
  assert.equal(said("Your flight is on Dec 24th."), "Your flight is on December 24th.");
  assert.equal(said("You're free all of Nov."), "You're free all of November.");
});

test("a name or word that is also a date abbreviation is spelled out only beside a date", async () => {
  const { spellOutDates } = await load();
  const said = (text) => spellOutDates(text, "en");
  assert.equal(
    said("Jan said the Sun was out, so we Sat outside."),
    "Jan said the Sun was out, so we Sat outside."
  );
  assert.equal(said("On the 19th, Jan said yes."), "On the 19th, Jan said yes.");
  assert.equal(said("It's on Sat, Nov 22."), "It's on Saturday, November 22.");
  assert.equal(said("The trip is 19 Jan to 2 Mar."), "The trip is 19 January to 2 March.");
  assert.equal(said("You're off Fri and Sat."), "You're off Friday and Saturday.");
  assert.equal(
    said("Thu Nguyen accepted, and Mon joins at 3 PM."),
    "Thu Nguyen accepted, and Mon joins at 3 PM."
  );
  assert.equal(
    said("The 1:1 with Thu moved to Mon, Nov 24."),
    "The 1:1 with Thu moved to Monday, November 24."
  );
  assert.equal(said("It's on Thu at 3 PM."), "It's on Thursday at 3 PM.");
  assert.equal(
    said("Pavel Novák and Octávio Sepúlveda meet Marc Augé."),
    "Pavel Novák and Octávio Sepúlveda meet Marc Augé."
  );
  assert.equal(said("It moved to the 4th of Jun."), "It moved to the 4th of June.");
});

test("an hour's :00 is dropped before AM or PM; other times stay as written", async () => {
  const { spellOutDates } = await load();
  const said = (text) => spellOutDates(text, "en");
  assert.equal(said("From 9:00 a.m. to 12:00pm."), "From 9 a.m. to 12pm.");
  assert.equal(
    said("It starts at 9:05 AM and ends at 15:00."),
    "It starts at 9:05 AM and ends at 15:00."
  );
});

test("an ISO date is said as a date, and longer words or timestamps are left alone", async () => {
  const { spellOutDates } = await load();
  const said = (text) => spellOutDates(text, "en");
  assert.equal(said("The review is on 2026-11-19."), "The review is on November 19, 2026.");
  assert.equal(said("Logged at 2026-11-19T15:00Z."), "Logged at 2026-11-19T15:00Z.");
  assert.equal(said("Build 2026-13-40 failed."), "Build 2026-13-40 failed.");
  assert.equal(said("Thursday's Decision on Monday."), "Thursday's Decision on Monday.");
});

test("other languages are left to the model", async () => {
  const { spellOutDates } = await load();
  assert.equal(spellOutDates("La reunión es el 19 nov.", "es"), "La reunión es el 19 nov.");
  assert.equal(spellOutDates("Am Mi, 19. Nov um 15 Uhr.", "de"), "Am Mi, 19. Nov um 15 Uhr.");
});
