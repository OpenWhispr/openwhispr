const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const {
  BUILTIN_ACTIONS,
  DETAILED_NOTES_KEY,
  FOLLOW_UP_EMAIL_KEY,
  GENERATE_NOTES_KEY,
  NOTE_ACTION_LIMITS,
} = require("../../src/helpers/builtinActions.js");

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

test("every built-in is named and described in English, matching its fallback text", () => {
  const { notes } = require("../../src/locales/en/translation.json");
  for (const action of BUILTIN_ACTIONS) {
    const key = action.translationKey.split(".").pop();
    assert.equal(notes.actions.builtin[key]?.name, action.name, action.translationKey);
    assert.equal(
      notes.actions.builtin[key]?.description,
      action.description,
      action.translationKey
    );
  }
});

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
    assert.equal(rows[0].kind, action.kind);
    assert.equal(rows[0].output, action.output);
    assert.equal(rows[0].client_id, translationKey);
    assert.deepEqual(rows[0].sections, action.sections);
  });

  action.previousPrompts.forEach((previousPrompt, index) => {
    const label = `${name}: previous default #${index + 1}`;

    test(`${label} upgrades once on launch`, (t) => {
      const db = createDb(t);
      if (!db) return;
      const { id } = builtinRows(db, translationKey)[0];
      // Rows from before templates had sections held a flat prompt.
      db.db
        .prepare("UPDATE actions SET prompt = ?, sections = NULL WHERE id = ?")
        .run(previousPrompt, id);
      db.db.close();

      relaunch((upgraded) => {
        const [row] = builtinRows(upgraded, translationKey);
        assert.equal(row.prompt, action.prompt);
        assert.deepEqual(row.sections, action.sections);
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
        .prepare("UPDATE actions SET prompt = ?, sections = NULL WHERE translation_key = ?")
        .run(edited, translationKey);
      db.db.close();

      relaunch((reopened) => {
        const [row] = builtinRows(reopened, translationKey);
        assert.equal(row.prompt, edited);
        assert.equal(row.sections, null, "an edited flat prompt stays flat");
      });
    });
  });
}

test("launch puts the default AI Summary template first, under its current name", (t) => {
  const db = createDb(t);
  if (!db) return;
  // As main shipped them: Generate Notes first, and the default under its old name.
  db.db
    .prepare("UPDATE actions SET sort_order = 0 WHERE translation_key = ?")
    .run(GENERATE_NOTES_KEY);
  db.db
    .prepare("UPDATE actions SET sort_order = 1, name = 'Detailed Notes' WHERE translation_key = ?")
    .run(DETAILED_NOTES_KEY);
  db.db.close();

  relaunch((migrated) => {
    const [first, second] = migrated.getActions();
    assert.equal(first.translation_key, DETAILED_NOTES_KEY);
    assert.equal(first.name, "AI Summary");
    assert.equal(second.translation_key, GENERATE_NOTES_KEY);
    migrated.db
      .prepare("UPDATE actions SET name = 'Team notes' WHERE translation_key = ?")
      .run(DETAILED_NOTES_KEY);
  });
  relaunch((again) => {
    assert.equal(
      builtinRows(again, DETAILED_NOTES_KEY)[0].name,
      "Team notes",
      "the user's name stays"
    );
  });
});

test("an upgrade to sections keeps a name the user gave the default template", (t) => {
  const db = createDb(t);
  if (!db) return;
  const detailed = BUILTIN_ACTIONS.find((a) => a.translationKey === DETAILED_NOTES_KEY);
  db.db
    .prepare(
      "UPDATE actions SET name = 'Team notes', prompt = ?, sections = NULL WHERE translation_key = ?"
    )
    .run(detailed.previousPrompts.at(-1), DETAILED_NOTES_KEY);
  db.db.close();

  relaunch((migrated) => {
    const [row] = builtinRows(migrated, DETAILED_NOTES_KEY);
    assert.deepEqual(row.sections, detailed.sections, "the old default still moves to sections");
    assert.equal(row.name, "Team notes");
  });
});

test("a database from before templates and chat actions migrates on launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const editedEmail = "Write a short thank-you email.";
  db.db.prepare("UPDATE actions SET client_id = NULL, kind = 'template', output = NULL").run();
  db.db
    .prepare("UPDATE actions SET prompt = ? WHERE translation_key = ?")
    .run(editedEmail, FOLLOW_UP_EMAIL_KEY);
  db.db
    .prepare("INSERT INTO actions (name, description, prompt, sort_order) VALUES (?, '', ?, 9)")
    .run("Board summary", "Summarize for the board.");
  db.db.close();

  let customClientId;
  relaunch((migrated) => {
    const [email] = builtinRows(migrated, FOLLOW_UP_EMAIL_KEY);
    assert.equal(email.kind, "action");
    assert.equal(email.output, "chat");
    assert.equal(email.prompt, editedEmail, "the user's edit is kept");
    assert.equal(email.client_id, FOLLOW_UP_EMAIL_KEY);

    const custom = migrated.getActions().find((row) => row.name === "Board summary");
    assert.equal(custom.kind, "template", "a custom action always rewrote the summary");
    assert.equal(custom.prompt, "Summarize for the board.");
    assert.equal(custom.sections, null);
    assert.match(custom.client_id, /^[0-9a-f-]{36}$/);
    customClientId = custom.client_id;
  });
  relaunch((steady) => {
    const custom = steady.getActions().find((row) => row.name === "Board summary");
    assert.equal(custom.client_id, customClientId, "client ids are assigned once");
  });
});

test("templates and actions are validated and normalized when saved", (t) => {
  const db = createDb(t);
  if (!db) return;

  const sectioned = db.createAction("Sales call", "", "", undefined, {
    sections: [
      { heading: "## Needs ", instruction: " What they want " },
      { heading: " ", instruction: "dropped" },
    ],
  });
  assert.equal(sectioned.success, true);
  assert.equal(sectioned.action.kind, "template");
  assert.equal(sectioned.action.output, null);
  assert.deepEqual(sectioned.action.sections, [
    { heading: "Needs", instruction: "What they want" },
  ]);

  assert.equal(db.createAction("Empty", "", "  ").success, false, "a template needs something");

  const action = db.createAction("Shorten", "", "Make it shorter.", undefined, {
    kind: "action",
    output: "summary",
    sections: [{ heading: "Ignored", instruction: "" }],
  });
  assert.equal(action.success, true);
  assert.equal(action.action.output, "summary");
  assert.equal(action.action.sections, null, "only templates have sections");
  assert.equal(
    db.createAction("Ask", "", "Draft it.", undefined, { kind: "action" }).action.output,
    "chat"
  );
  assert.equal(db.createAction("Nothing", "", "", undefined, { kind: "action" }).success, false);
  assert.equal(
    db.createAction("x".repeat(NOTE_ACTION_LIMITS.name + 1), "", "Too long a name.").success,
    false
  );

  const updated = db.updateAction(action.action.id, { output: "chat", kind: "template" });
  assert.equal(updated.success, true);
  assert.equal(updated.action.kind, "action", "a row's kind never changes");
  assert.equal(updated.action.output, "chat");

  const [detailed] = builtinRows(db, DETAILED_NOTES_KEY);
  assert.equal(db.updateAction(detailed.id, { sections: [] }).success, false);
});

test("an older build renaming the newer built-ins doesn't stop the next launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const newerKeys = ["notes.actions.builtin.makeTodos", "notes.actions.builtin.createOutline"];
  // What a build that predates Make to-dos and Create outline does to their rows.
  db.db
    .prepare(
      "UPDATE actions SET translation_key = ? WHERE is_builtin = 1 AND translation_key IN (?, ?)"
    )
    .run(GENERATE_NOTES_KEY, ...newerKeys);
  db.db.close();

  relaunch((upgraded) => {
    for (const key of [GENERATE_NOTES_KEY, ...newerKeys]) {
      assert.equal(builtinRows(upgraded, key).length, 1, key);
    }
  });
});

test("a built-in action pointed at the summary stays there across launches", (t) => {
  const db = createDb(t);
  if (!db) return;
  const [email] = builtinRows(db, FOLLOW_UP_EMAIL_KEY);
  assert.equal(db.updateAction(email.id, { output: "summary" }).success, true);
  db.db.close();

  relaunch((reopened) => {
    assert.equal(builtinRows(reopened, FOLLOW_UP_EMAIL_KEY)[0].output, "summary");
  });
});
