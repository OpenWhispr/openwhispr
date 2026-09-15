const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const { BUILTIN_ACTIONS } = require("../../src/helpers/builtinActions.js");

const builtinRows = (db, translationKey) =>
  db.getActions().filter((row) => row.translation_key === translationKey);

// Opens the database again on the same userData directory, which reruns the
// startup seeding the way the next app launch would.
function relaunch(check) {
  const db = new DatabaseManager();
  try {
    check(db);
  } finally {
    db.db.close();
  }
}

test("no built-in lists its current prompt as a previous default", () => {
  for (const action of BUILTIN_ACTIONS) {
    assert.equal(action.previousPrompts.includes(action.prompt), false, action.name);
  }
});

for (const action of BUILTIN_ACTIONS) {
  const { translationKey, name } = action;

  test(`${name}: a fresh install seeds the current prompt`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const rows = builtinRows(db, translationKey);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prompt, action.prompt);
  });

  action.previousPrompts.forEach((previousPrompt, index) => {
    const label = `${name}: previous default #${index + 1}`;

    test(`${label} upgrades once on launch`, (t) => {
      const db = createDb(t);
      if (!db) return;
      const { id } = builtinRows(db, translationKey)[0];
      db.db.prepare("UPDATE actions SET prompt = ? WHERE id = ?").run(previousPrompt, id);
      db.db.close();

      relaunch((upgraded) => {
        assert.equal(builtinRows(upgraded, translationKey)[0].prompt, action.prompt);
      });
      relaunch((steady) => {
        const rows = builtinRows(steady, translationKey);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, id);
        assert.equal(rows[0].prompt, action.prompt);
      });
    });

    test(`${label} edited by the user survives launch`, (t) => {
      const db = createDb(t);
      if (!db) return;
      const edited = `${previousPrompt}\nAlways use numbered lists.`;
      db.db
        .prepare("UPDATE actions SET prompt = ? WHERE translation_key = ?")
        .run(edited, translationKey);
      db.db.close();

      relaunch((reopened) => {
        assert.equal(builtinRows(reopened, translationKey)[0].prompt, edited);
      });
    });
  });
}
