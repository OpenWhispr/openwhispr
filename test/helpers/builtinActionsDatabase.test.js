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
    assert.equal(rows[0].icon, action.icon);
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

test("launch puts the default AI Summary template first, then Detailed Notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  // As an earlier build ordered them, with Detailed Notes as the default.
  db.db
    .prepare("UPDATE actions SET sort_order = 0 WHERE translation_key = ?")
    .run(DETAILED_NOTES_KEY);
  db.db
    .prepare("UPDATE actions SET sort_order = 1 WHERE translation_key = ?")
    .run(GENERATE_NOTES_KEY);
  db.db.close();

  relaunch((migrated) => {
    const [first, second] = migrated.getActions();
    assert.equal(first.translation_key, GENERATE_NOTES_KEY);
    assert.equal(second.translation_key, DETAILED_NOTES_KEY);
  });
});

test("an upgrade to sections keeps a name the user gave Detailed Notes", (t) => {
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
  assert.equal(action.action.output, "chat");
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
  const newerKeys = ["notes.actions.builtin.makeTodos", "notes.actions.builtin.lengthen"];
  // What a build that predates these built-ins does to their rows.
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

test("legacy summary destinations normalize without changing any other custom fields", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { action } = db.createAction(
    "Make notes shorter",
    "Keep this description",
    "My edited prompt",
    "mail",
    { kind: "action" }
  );
  db.db.prepare("UPDATE actions SET output = 'summary' WHERE kind = 'action'").run();
  const raw = db.db.prepare("SELECT * FROM actions WHERE id = ?").get(action.id);
  assert.equal(db.getAction(action.id).output, "chat", "reads ignore stale output before restart");
  db.db.close();
  for (let run = 0; run < 2; run++)
    relaunch((reopened) => {
      assert.deepEqual(reopened.db.prepare("SELECT * FROM actions WHERE id = ?").get(action.id), {
        ...raw,
        output: "chat",
      });
      assert.equal(builtinRows(reopened, FOLLOW_UP_EMAIL_KEY)[0].output, "chat");
      assert.equal(builtinRows(reopened, "notes.actions.builtin.addTldr")[0].output, "chat");
      assert.equal(builtinRows(reopened, "notes.actions.builtin.lengthen").length, 1);
    });
});

test("writes enforce stored built-in identity and still reject invalid destinations", (t) => {
  const db = createDb(t);
  if (!db) return;
  for (const key of ["shorten", "lengthen"]) {
    const [row] = builtinRows(db, `notes.actions.builtin.${key}`);
    const updated = db.updateAction(row.id, {
      output: "chat",
      prompt: "Edited instructions",
      is_builtin: 0,
      translation_key: null,
    });
    assert.equal(updated.action.output, "summary");
    assert.equal(updated.action.prompt, "Edited instructions");
  }
  const { action } = db.createAction("Make notes longer", "", "Update the summary", undefined, {
    kind: "action",
    output: "summary",
  });
  const updated = db.updateAction(action.id, {
    output: "summary",
    is_builtin: 1,
    translation_key: "notes.actions.builtin.lengthen",
    client_id: "notes.actions.builtin.lengthen",
  });
  assert.equal(updated.action.output, "chat");
  assert.equal(updated.action.client_id, action.client_id);
  assert.equal(db.updateAction(action.id, { output: "auto" }).success, false);
  assert.equal(
    db.createAction("Bad", "", "x", undefined, { kind: "action", output: "unknown" }).success,
    false
  );
});

test("renamed built-ins upgrade stock labels but keep user edits", (t) => {
  const db = createDb(t);
  if (!db) return;
  const renamed = BUILTIN_ACTIONS.filter((a) => a.previousNames?.length);
  for (const a of renamed)
    db.db
      .prepare("UPDATE actions SET name = ?, description = ? WHERE translation_key = ?")
      .run(a.previousNames[0], a.previousDescriptions[0], a.translationKey);
  db.db.close();
  relaunch((upgraded) => {
    for (const a of renamed) {
      const [row] = builtinRows(upgraded, a.translationKey);
      assert.equal(row.name, a.name);
      assert.equal(row.description, a.description);
      upgraded.updateAction(row.id, {
        name: "My label",
        description: "My description",
        prompt: "My prompt",
      });
    }
    assert.deepEqual(
      upgraded
        .getActions()
        .filter((a) => a.kind === "action")
        .slice(0, 5)
        .map((a) => a.translation_key.split(".").pop()),
      ["followUpEmail", "makeTodos", "shorten", "lengthen", "addTldr"]
    );
  });
  relaunch((steady) => {
    for (const a of renamed) {
      const [row] = builtinRows(steady, a.translationKey);
      assert.equal(row.name, "My label");
      assert.equal(row.description, "My description");
      assert.equal(row.prompt, "My prompt");
    }
  });
});

test("TL;DR stock prompt upgrades without replacing an edited description", (t) => {
  const db = createDb(t);
  if (!db) return;
  const tldr = BUILTIN_ACTIONS.find((a) => a.translationKey.endsWith(".addTldr"));
  const [row] = builtinRows(db, tldr.translationKey);
  db.db
    .prepare("UPDATE actions SET prompt = ?, description = ? WHERE id = ?")
    .run(tldr.previousPrompts[0], "My description", row.id);
  db.db.close();
  relaunch((upgraded) => {
    const action = upgraded.getAction(row.id);
    assert.equal(action.prompt, tldr.prompt);
    assert.equal(action.description, "My description");
    assert.equal(action.output, "chat");
  });
});

test("TL;DR upgrades its stock icon once while preserving edited and custom icons", (t) => {
  const db = createDb(t);
  if (!db) return;
  const [tldr] = builtinRows(db, "notes.actions.builtin.addTldr");
  const custom = db.createAction("Write TL;DR", "My description", "My prompt", "sparkles", {
    kind: "action",
  }).action;
  const customBefore = db.db.prepare("SELECT * FROM actions WHERE id = ?").get(custom.id);
  db.db.prepare("UPDATE actions SET icon = 'sparkles' WHERE id = ?").run(tldr.id);
  db.db.close();
  for (let run = 0; run < 2; run++)
    relaunch((reopened) => {
      assert.equal(reopened.getAction(tldr.id).icon, "message-square-text");
      assert.deepEqual(
        reopened.db.prepare("SELECT * FROM actions WHERE id = ?").get(custom.id),
        customBefore
      );
    });
  relaunch((reopened) => {
    reopened.updateAction(tldr.id, { icon: "mail" });
  });
  relaunch((reopened) => {
    assert.equal(reopened.getAction(tldr.id).icon, "mail", "a non-stock built-in icon is kept");
  });
});
