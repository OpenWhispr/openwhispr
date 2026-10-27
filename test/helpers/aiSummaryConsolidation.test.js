const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const builtins = require("../../src/helpers/builtinActions.js");
const { compileTemplatePrompt } = require("../../src/helpers/templatePrompts.js");
const { GENERATE_NOTES_KEY, DETAILED_NOTES_KEY } = builtins;
const detailed = builtins.LEGACY_DETAILED_NOTES;

function seedDetailed(db, changes = {}) {
  const row = {
    name: detailed.name,
    description: detailed.description,
    icon: detailed.icon,
    prompt: detailed.prompt,
    sections: JSON.stringify(detailed.sections),
    translation_key: DETAILED_NOTES_KEY,
    client_id: DETAILED_NOTES_KEY,
    ...changes,
  };
  const { lastInsertRowid } = db.db
    .prepare(
      `INSERT INTO actions (name, description, icon, prompt, sections, translation_key,
        client_id, is_builtin, kind, sort_order)
       VALUES (@name, @description, @icon, @prompt, @sections, @translation_key,
        @client_id, 1, 'template', 1)`
    )
    .run(row);
  return db.db.prepare("SELECT * FROM actions WHERE id = ?").get(lastInsertRowid);
}

function reopen(check) {
  const db = new DatabaseManager();
  try {
    check(db);
  } finally {
    db.db.close();
  }
}

test("an edited legacy default stays available after AI Summary in the template list", (t) => {
  const db = createDb(t);
  if (!db) return;
  const legacy = seedDetailed(db, { prompt: "My own rules.", sections: null });
  db.db.prepare("UPDATE actions SET sort_order = 0 WHERE id = ?").run(legacy.id);
  db.db.close();
  reopen((next) => {
    const templates = next.getActions().filter((row) => row.kind === "template");
    assert.equal(templates[0].translation_key, GENERATE_NOTES_KEY);
    assert.equal(templates.find((row) => row.id === legacy.id).sort_order, 1);
  });
});

test("fresh installs expose one AI Summary with the existing detailed request", (t) => {
  const db = createDb(t);
  if (!db) return;
  const templates = db.getActions().filter((row) => row.kind === "template");
  assert.equal(templates[0].translation_key, GENERATE_NOTES_KEY);
  assert.equal(
    templates.some((row) => row.translation_key === DETAILED_NOTES_KEY),
    false
  );
  assert.deepEqual(
    templates[0].sections.map((s) => s.heading),
    ["Summary", "Discussion", "Decisions", "Action Items", "Open Questions"]
  );
  for (const isMeetingNote of [true, false]) {
    assert.equal(
      compileTemplatePrompt(templates[0], { isMeetingNote }),
      compileTemplatePrompt({ ...detailed, translation_key: DETAILED_NOTES_KEY }, { isMeetingNote })
    );
  }
});

for (const [index, prompt] of [detailed.prompt, ...detailed.previousPrompts].entries()) {
  test(`stock Detailed Notes version ${index} retires without changing saved notes`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const legacy = seedDetailed(db, {
      prompt,
      sections: index === 0 ? JSON.stringify(detailed.sections, null, 2) : null,
    });
    db.db
      .prepare(
        `INSERT INTO notes (title, content, enhanced_content, enhancement_template_id, client_note_id, space_id)
       VALUES ('Saved note', 'My notes', 'Keep this exact summary', ?, 'fixture-note', ?)`
      )
      .run(DETAILED_NOTES_KEY, db.getPrivateSpaceId());
    const notes = db.db.prepare("SELECT * FROM notes").all();
    const summaryId = db.getActions().find((r) => r.translation_key === GENERATE_NOTES_KEY).id;
    db.db.close();
    for (let run = 0; run < 2; run++) {
      reopen((next) => {
        assert.equal(
          next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id),
          undefined
        );
        assert.deepEqual(next.db.prepare("SELECT * FROM notes").all(), notes);
        const summaries = next.getActions().filter((r) => r.translation_key === GENERATE_NOTES_KEY);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].id, summaryId);
      });
    }
  });
}

for (const [label, changes] of [
  ["flat prompt", { prompt: "My rules.", sections: null }],
  ["sections", { sections: '[{"heading":"Custom","instruction":"Keep specifics"}]' }],
  ["name", { name: "Team notes" }],
  ["description", { description: "Our template" }],
  ["icon", { icon: "mail" }],
  ["malformed sections", { sections: "not json" }],
  [
    "unrecognized section field",
    {
      sections: JSON.stringify([
        { ...detailed.sections[0], extra: true },
        ...detailed.sections.slice(1),
      ]),
    },
  ],
]) {
  test(`customized Detailed Notes ${label} survives two launches unchanged`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const legacy = seedDetailed(db, changes);
    db.db.close();
    for (let run = 0; run < 2; run++) {
      reopen((next) => {
        assert.deepEqual(
          next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id),
          legacy
        );
      });
    }
  });
}

test("a renamed flat Detailed Notes default moves to sections and keeps its name", (t) => {
  const db = createDb(t);
  if (!db) return;
  const legacy = seedDetailed(db, {
    name: "Team notes",
    prompt: detailed.previousPrompts.at(-1),
    sections: null,
  });
  db.db.close();
  for (let run = 0; run < 2; run++) {
    reopen((next) => {
      const row = next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id);
      assert.equal(row.name, "Team notes");
      assert.equal(row.prompt, detailed.prompt);
      assert.deepEqual(JSON.parse(row.sections), detailed.sections);
    });
  }
});

test("stock Detailed Notes stays beside a customized AI Summary", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db
    .prepare(
      "UPDATE actions SET prompt = 'My summary rules.', sections = NULL WHERE translation_key = ?"
    )
    .run(GENERATE_NOTES_KEY);
  const legacy = seedDetailed(db);
  db.db.close();
  for (let run = 0; run < 2; run++) {
    reopen((next) => {
      assert.deepEqual(
        next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id),
        legacy
      );
      const summary = next.getActions().find((row) => row.translation_key === GENERATE_NOTES_KEY);
      assert.equal(summary.prompt, "My summary rules.");
    });
  }
});

test("a flat stock AI Summary moves to sections and retires stock Detailed Notes", (t) => {
  const db = createDb(t);
  if (!db) return;
  const summary = builtins.BUILTIN_ACTIONS.find((a) => a.translationKey === GENERATE_NOTES_KEY);
  db.db
    .prepare("UPDATE actions SET prompt = ?, sections = NULL WHERE translation_key = ?")
    .run(summary.previousPrompts.at(-1), GENERATE_NOTES_KEY);
  const legacy = seedDetailed(db, { prompt: detailed.previousPrompts.at(-1), sections: null });
  db.db.close();
  for (let run = 0; run < 2; run++) {
    reopen((next) => {
      assert.equal(next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id), undefined);
      const row = next.getActions().find((r) => r.translation_key === GENERATE_NOTES_KEY);
      assert.equal(row.prompt, summary.prompt);
      assert.deepEqual(row.sections, summary.sections);
    });
  }
});

test("a second Detailed Notes without a client ID beside a customized AI Summary still opens", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db
    .prepare(
      "UPDATE actions SET prompt = 'My summary rules.', sections = NULL WHERE translation_key = ?"
    )
    .run(GENERATE_NOTES_KEY);
  seedDetailed(db, { translation_key: GENERATE_NOTES_KEY });
  seedDetailed(db, { client_id: null, prompt: detailed.previousPrompts.at(-1), sections: null });
  db.db.close();
  for (let run = 0; run < 2; run++) {
    reopen((next) => {
      const rows = next.getActions();
      assert.equal(rows.filter((row) => row.translation_key === DETAILED_NOTES_KEY).length, 2);
      assert.equal(new Set(rows.map((row) => row.client_id)).size, rows.length);
    });
  }
});

for (const customized of [false, true]) {
  for (const identity of ["downgraded", "no client ID"]) {
    test(`${identity} ${customized ? "edited" : "stock"} Detailed Notes avoids default ID collisions`, (t) => {
      const db = createDb(t);
      if (!db) return;
      const legacy = seedDetailed(db, {
        ...(customized ? { prompt: "My rules.", sections: null } : {}),
        ...(identity === "downgraded"
          ? { translation_key: GENERATE_NOTES_KEY }
          : { client_id: null }),
      });
      db.db.close();
      for (let run = 0; run < 2; run++) {
        reopen((next) => {
          const rows = next.getActions();
          assert.equal(rows.filter((row) => row.translation_key === GENERATE_NOTES_KEY).length, 1);
          assert.equal(new Set(rows.map((row) => row.client_id)).size, rows.length);
          const retained = next.db.prepare("SELECT * FROM actions WHERE id = ?").get(legacy.id);
          if (customized) {
            assert.equal(retained.translation_key, DETAILED_NOTES_KEY);
            assert.equal(retained.client_id, DETAILED_NOTES_KEY);
            assert.equal(retained.prompt, "My rules.");
          } else {
            assert.equal(retained, undefined);
          }
        });
      }
    });
  }
}
