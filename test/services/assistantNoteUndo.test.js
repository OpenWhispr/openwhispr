const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { UNDO_TTL_MS, initializeNoteUndo } = require("../../src/helpers/noteUndo");

// Real SQLite and the real tool/registry, with only Electron/provider transport stubbed.
test("safe assistant edits and atomic Undo", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-assistant-undo-"));
  const originalLoad = Module._load;
  let database;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "electron")
        return {
          app: { getPath: () => directory, getAppPath: () => process.cwd(), isReady: () => false },
        };
      return originalLoad.call(this, request, parent, isMain);
    };
    const DatabaseManager = require("../../src/helpers/database.js");
    database = new DatabaseManager();
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    database.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id) => database.getNote(id),
        updateNote: async (id, updates, options) => database.updateNote(id, updates, options),
        getFolders: async (spaceId) => database.getFolders(spaceId),
        createFolder: async (name, spaceId) => database.createFolder(name, spaceId),
      },
    },
  });
  const vite = await createRendererServer(t);
  const { syncService } = await vite.ssrLoadModule("/services/SyncService.ts");
  const pushes = [];
  t.mock.method(syncService, "debouncedPush", (...args) => pushes.push(args));
  const { updateNoteTool } = await vite.ssrLoadModule("/services/tools/updateNoteTool.ts");
  const { executeTool } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const fresh = () => {
    const note = database.saveNote("Workshop", "Private notes", "meeting").note;
    database.updateNote(note.id, {
      enhanced_content: "## Decisions\nKeep it\n\n## Next\nDo it",
      transcript: "Source",
      enhancement_prompt: "Prompt",
      enhanced_at_content_hash: "hash",
    });
    return database.getNote(note.id);
  };
  const tokenFor = (id) => database.getNoteUndos().find((edit) => edit.noteId === id)?.token;
  const edit = (note, updates, turn) =>
    updateNoteTool.execute(
      { id: note.id, ...updates },
      turn && { messageId: turn, signal: new AbortController().signal }
    );

  for (const operation of ["rename", "move"])
    await t.test(
      `${operation} with extraneous blanks preserves documents and metadata`,
      async () => {
        const note = fresh();
        const folder = database.createFolder(`Folder ${note.id}`, note.space_id).folder;
        const result = await edit(note, {
          ...(operation === "rename" ? { title: "Renamed" } : { folder: folder.name }),
          content: "",
          summary: " \n ",
        });
        assert.equal(result.success, true);
        assert.deepEqual(result.data.ignoredFields, ["content", "summary"]);
        const saved = database.getNote(note.id);
        for (const key of [
          "content",
          "enhanced_content",
          "transcript",
          "enhancement_prompt",
          "enhanced_at_content_hash",
        ])
          assert.equal(saved[key], note[key]);
        assert.equal(
          saved[operation === "rename" ? "title" : "folder_id"],
          operation === "rename" ? "Renamed" : folder.id
        );
        assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
        assert.equal(database.getNote(note.id).folder_id, note.folder_id);
        assert.equal(database.getNote(note.id).title, note.title);
      }
    );

  await t.test(
    "omitted/null fields are absent, wrong types fail, unmarked blanks never clear",
    async () => {
      const note = fresh();
      assert.equal(
        (await edit(note, { title: "Renamed", content: null, summary: null })).success,
        true
      );
      assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      const token = tokenFor(note.id);
      for (const fields of [
        { content: 3 },
        { summary: false },
        { title: {} },
        { folder: [] },
        { clear_fields: "summary" },
        { clear_fields: ["transcript"] },
        { summary: "replacement", clear_fields: ["summary"] },
        { summary: "" },
        {},
      ]) {
        assert.equal((await edit(note, fields)).success, false, JSON.stringify(fields));
        assert.equal(tokenFor(note.id), token);
        assert.equal(database.getNote(note.id).content, note.content);
        assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
      }
    }
  );

  await t.test(
    "a numeric string ID edits the note; a malformed one names the argument",
    async () => {
      const note = fresh();
      assert.equal((await edit(note, { id: String(note.id), title: "By string" })).success, true);
      assert.equal(database.getNote(note.id).title, "By string");
      const result = await edit(note, { id: `${note.id}x`, title: "Rejected" });
      assert.equal(result.success, false);
      assert.equal(result.displayText, "Invalid note update argument: id");
      assert.equal(database.getNote(note.id).title, "By string");
    }
  );

  await t.test(
    "an expired recovery is neither offered nor restorable, and launch prunes it",
    async () => {
      const note = fresh();
      await edit(note, { title: "Old edit" });
      const token = tokenFor(note.id);
      database.db
        .prepare("UPDATE assistant_note_undo SET created_at = ? WHERE token = ?")
        .run(Date.now() - UNDO_TTL_MS - 1, token);
      assert.equal(tokenFor(note.id), undefined);
      assert.equal(database.undoNoteUpdate(token).success, false);
      assert.equal(database.getNote(note.id).title, "Old edit");
      initializeNoteUndo(database.db);
      const remaining = database.db
        .prepare("SELECT COUNT(*) AS count FROM assistant_note_undo WHERE token = ?")
        .get(token);
      assert.equal(remaining.count, 0);
    }
  );

  for (const field of ["content", "summary"])
    await t.test(`explicit ${field} clearing and reopen/Undo`, async () => {
      const note = fresh();
      const result = await edit(note, { clear_fields: [field] });
      assert.equal(result.success, true);
      assert.deepEqual(result.data.updatedFields, [field]);
      const key = field === "summary" ? "enhanced_content" : field;
      assert.equal(database.getNote(note.id)[key] ?? "", "");
      database.db.close();
      database.db = new (require("better-sqlite3"))(path.join(directory, "transcriptions.db"));
      assert.equal(database.getNote(note.id)[key] ?? "", "");
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      const restored = database.getNote(note.id);
      for (const key of [
        "title",
        "content",
        "enhanced_content",
        "transcript",
        "enhancement_prompt",
        "enhanced_at_content_hash",
      ])
        assert.equal(restored[key], note[key]);
      assert.equal(tokenFor(note.id), undefined);
    });

  await t.test("Undo of a first summary is a clear that syncs", async () => {
    const note = database.saveNote("Untouched", "Private notes", "meeting").note;
    await edit(database.getNote(note.id), { summary: "Written by the assistant" });
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
    const restored = database.getNote(note.id);
    assert.equal(restored.enhanced_content ?? "", "");
    assert.equal(restored.enhanced_content_sync_operation, "clear");
  });

  await t.test(
    "partial section removal; edits in one turn share an Undo, a later turn's stands alone",
    async () => {
      const note = fresh();
      await edit(note, { summary: "## Next\nDo it" }, "turn-1");
      const first = tokenFor(note.id);
      await edit(note, { title: "Renamed" }, "turn-1");
      const second = tokenFor(note.id);
      assert.notEqual(second, first);
      assert.equal(database.undoNoteUpdate(first).success, false);
      await edit(note, { content: "Later turn" }, "turn-2");
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      assert.equal(database.getNote(note.id).content, note.content);
      assert.equal(database.getNote(note.id).title, "Renamed", "an earlier turn stays applied");
      assert.equal(tokenFor(note.id), undefined);

      const other = fresh();
      await edit(other, { summary: "## Next\nDo it" }, "turn-3");
      await edit(other, { title: "Renamed" }, "turn-3");
      assert.equal(database.undoNoteUpdate(tokenFor(other.id)).success, true);
      assert.equal(database.getNote(other.id).title, other.title);
      assert.equal(database.getNote(other.id).enhanced_content, other.enhanced_content);
    }
  );

  await t.test("edits of one note in the same model step both apply", async () => {
    const note = fresh();
    const results = await Promise.all([
      edit(note, { summary: "## Next\nDo it" }, "step"),
      edit(note, { content: "Added reminder" }, "step"),
    ]);
    assert.deepEqual(
      results.map((result) => result.success),
      [true, true]
    );
    assert.equal(database.getNote(note.id).enhanced_content, "## Next\nDo it");
    assert.equal(database.getNote(note.id).content, "Added reminder");
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
    assert.equal(database.getNote(note.id).content, note.content);
  });

  await t.test("the cloud pull echoing a cleared summary keeps Undo", async () => {
    const note = fresh();
    await edit(note, { clear_fields: ["summary"] });
    const token = tokenFor(note.id);
    const saved = database.getNote(note.id);
    database.upsertNoteFromCloud(
      {
        ...saved,
        id: `cloud-${note.id}`,
        created_at: "2026-10-09T00:00:00.000Z",
        updated_at: "2099-01-01T00:00:00.000Z",
      },
      saved.folder_id,
      saved.space_id
    );
    assert.equal(database.getNote(note.id).enhanced_content, null, "the pull stores NULL");
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.undoNoteUpdate(token).success, true);
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
  });

  await t.test("each recovery is offered once", async () => {
    const note = fresh();
    await edit(note, { title: "Offered" });
    const token = tokenFor(note.id);
    assert.equal(database.claimNoteUndo(token), true);
    assert.equal(database.claimNoteUndo(token), false);
    assert.equal(database.claimNoteUndo("missing"), false);
    assert.equal(database.undoNoteUpdate(token).success, true, "claiming keeps it restorable");
  });

  await t.test("launch replaces an older Undo trigger", async () => {
    database.db.exec(`
      DROP TRIGGER assistant_note_undo_update;
      CREATE TRIGGER assistant_note_undo_update AFTER UPDATE ON notes BEGIN SELECT 1; END;
    `);
    initializeNoteUndo(database.db);
    const note = fresh();
    await edit(note, { title: "Renamed" });
    database.updateNote(note.id, { content: "Manual edit" });
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("failed save rolls back and cannot create recovery or sync", async () => {
    const note = fresh();
    const before = pushes.length;
    const stub = t.mock.method(database, "updateNote", () => ({ success: false }));
    const result = await edit(note, { title: "Failed" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.equal(tokenFor(note.id), undefined);
    assert.equal(pushes.length, before);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test(
    "late committed save remains undoable after registry cancellation and note switch",
    async () => {
      const note = fresh();
      const other = fresh();
      const controller = new AbortController();
      let release, started;
      const saving = new Promise((resolve) => {
        started = resolve;
      });
      const stub = t.mock.method(globalThis.window.electronAPI, "updateNote", async (...args) => {
        const result = database.updateNote(...args);
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return result;
      });
      // A failed assertion must not leave the stalled stub in place: every
      // later edit would wait on it forever.
      try {
        const pending = executeTool(
          updateNoteTool,
          { id: note.id, content: "Assistant replacement" },
          { signal: controller.signal }
        );
        await saving;
        controller.abort();
        assert.equal((await pending).success, false);
        assert.equal(database.getNote(other.id).content, other.content);
        assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
      } finally {
        release?.();
        await new Promise((resolve) => setImmediate(resolve));
        stub.mock.restore();
      }
      assert.equal(database.getNote(note.id).content, note.content);
    }
  );

  for (const change of [
    "manual",
    "edit and revert",
    "cloud",
    "deleted",
    "hard deleted",
    "identity",
    "dirty draft",
  ])
    await t.test(`${change} prevents a stale Undo`, async () => {
      const note = fresh();
      await edit(note, { content: "Assistant replacement" });
      const token = tokenFor(note.id);
      if (change === "manual") database.updateNote(note.id, { title: "Manual title" });
      if (change === "edit and revert") {
        database.updateNote(note.id, { content: "Manual edit" });
        database.updateNote(note.id, { content: "Assistant replacement" });
      }
      if (change === "cloud")
        database.db.prepare("UPDATE notes SET content = 'Remote edit' WHERE id = ?").run(note.id);
      if (change === "deleted") database.updateNote(note.id, { deleted_at: "2026-10-09" });
      if (change === "hard deleted")
        database.db.prepare("DELETE FROM notes WHERE id = ?").run(note.id);
      if (change === "identity")
        database.updateNote(note.id, { client_note_id: "replacement-identity" });
      if (change === "dirty draft") database.discardNoteUndo(note.id);
      const before = database.getNote(note.id);
      assert.equal(database.undoNoteUpdate(token).success, false);
      assert.deepEqual(database.getNote(note.id), before);
    });

  await t.test(
    "sync acknowledgement preserves Undo and unrelated notes have independent tokens",
    async () => {
      const one = fresh(),
        two = fresh();
      await edit(one, { title: "One" });
      const token = tokenFor(one.id);
      await edit(two, { title: "Two" });
      database.updateNote(one.id, { sync_status: "synced", cloud_updated_at: "2026-10-09" });
      assert.equal(database.undoNoteUpdate(token).success, true);
      assert.equal(database.getNote(two.id).title, "Two");
      assert.ok(tokenFor(two.id));
    }
  );

  await t.test("first cloud create acknowledgement keeps recovery", async () => {
    const note = fresh();
    await edit(note, { title: "Synced edit" });
    const token = tokenFor(note.id);
    const snapshot = database.getNote(note.id);
    const ack = database.acknowledgeNoteCreate(
      note.id,
      snapshot,
      `cloud-${note.id}`,
      "2026-10-09",
      "owner-one"
    );
    // The create carried the edited text, so it settles in one request.
    assert.equal(ack.outcome, "synced");
    assert.equal(database.getNote(note.id).cloud_id, `cloud-${note.id}`);
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.undoNoteUpdate(token).success, true);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test("journal failure rolls back the edit; failed Undo retains recovery", async () => {
    const note = fresh();
    database.db.exec(
      "CREATE TEMP TRIGGER fail_undo_journal BEFORE INSERT ON assistant_note_undo BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    );
    assert.equal((await edit(note, { title: "Must roll back" })).success, false);
    database.db.exec("DROP TRIGGER fail_undo_journal");
    assert.equal(database.getNote(note.id).title, note.title);
    assert.equal(tokenFor(note.id), undefined);
    await edit(note, { title: "Recoverable" });
    const token = tokenFor(note.id);
    const failure = t.mock.method(database, "updateNote", () => ({
      success: false,
      error: "disk full",
    }));
    assert.equal(database.undoNoteUpdate(token).success, false);
    failure.mock.restore();
    assert.equal(tokenFor(note.id), token);
    assert.equal(database.getNote(note.id).title, "Recoverable");
  });

  await t.test("a removal that would leave a field empty is pointed to clear_fields", async () => {
    const note = fresh();
    const result = await edit(note, { summary: " " });
    assert.equal(result.success, false);
    assert.match(result.displayText, /removal that leaves nothing\), use clear_fields/);
    const renamed = await edit(note, { title: "", folder: " ", content: "Kept" });
    assert.equal(renamed.success, true);
    assert.deepEqual(renamed.data.ignoredFields, ["title", "folder"]);
    assert.equal(database.getNote(note.id).title, note.title);
  });

  await t.test("a trashed note is not edited", async () => {
    const note = fresh();
    database.updateNote(note.id, { deleted_at: "2026-10-09" });
    const result = await edit(note, { title: "Edited in the trash" });
    assert.equal(result.success, false);
    assert.match(result.displayText, /in the trash/);
    const trashed = database.getNote(note.id);
    assert.equal(
      database.updateNote(note.id, { title: "Direct" }, { undoable: true, expected: trashed })
        .success,
      false
    );
    assert.equal(database.getNote(note.id).title, note.title);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("an unchanged or unsupported edit writes nothing", async () => {
    const note = fresh();
    database.updateNote(note.id, { sync_status: "synced" });
    assert.equal((await edit(note, { title: note.title })).success, true);
    database.updateNote(note.id, { content: "" });
    database.updateNote(note.id, { sync_status: "synced" });
    assert.equal((await edit(note, { clear_fields: ["content"] })).success, true);
    assert.equal(database.getNote(note.id).sync_status, "synced");
    assert.equal(tokenFor(note.id), undefined);
    const direct = database.updateNote(
      note.id,
      { transcript: "Rewritten" },
      { undoable: true, expected: database.getNote(note.id) }
    );
    assert.equal(direct.success, false);
    assert.equal(database.getNote(note.id).transcript, note.transcript);
  });

  await t.test("a toast's discard retires only its own recovery", async () => {
    const note = fresh();
    await edit(note, { title: "First" });
    const first = tokenFor(note.id);
    await edit(note, { title: "Second" });
    const second = tokenFor(note.id);
    database.discardNoteUndo(note.id, first);
    assert.equal(tokenFor(note.id), second);
    database.discardNoteUndo(note.id, second);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test(
    "a folder that moved to another space is neither a target nor restored",
    async () => {
      database.setActiveAccountId("account-team");
      const team = database.db
        .prepare(
          "INSERT INTO spaces (client_space_id, kind, name) VALUES ('undo-team', 'team', 'Team')"
        )
        .run().lastInsertRowid;
      database.db
        .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, 'account-team')")
        .run(team);
      const moveToTeam = (folder) =>
        database.db.prepare("UPDATE folders SET space_id = ? WHERE id = ?").run(team, folder.id);
      const note = fresh();
      const target = database.createFolder(`Target ${note.id}`, note.space_id).folder;
      moveToTeam(target);
      const refused = database.updateNote(
        note.id,
        { folder_id: target.id },
        { undoable: true, expected: note }
      );
      assert.equal(refused.success, false);
      assert.equal(database.getNote(note.id).space_id, note.space_id);

      const original = database.createFolder(`Original ${note.id}`, note.space_id).folder;
      database.updateNote(note.id, { folder_id: original.id });
      await edit(database.getNote(note.id), { folder: `Moved ${note.id}` });
      moveToTeam(original);
      assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, false);
      assert.equal(database.getNote(note.id).space_id, note.space_id);
      database.setActiveAccountId(null);
    }
  );

  await t.test("a journal of an earlier shape is replaced at launch", async () => {
    database.db.exec(`
      DROP TABLE assistant_note_undo;
      CREATE TABLE assistant_note_undo (note_id INTEGER PRIMARY KEY, token TEXT, previous TEXT);
    `);
    initializeNoteUndo(database.db);
    const note = fresh();
    await edit(note, { title: "After repair" });
    assert.equal(database.undoNoteUpdate(tokenFor(note.id)).success, true);
  });

  await t.test("without the journal, assistant edits still save", async () => {
    database.noteUndoReady = false;
    try {
      const note = fresh();
      assert.equal((await edit(note, { title: "No journal" })).success, true);
      assert.equal(database.getNote(note.id).title, "No journal");
      assert.deepEqual(database.getNoteUndos(), []);
      assert.equal(database.claimNoteUndo("any"), false);
      database.discardNoteUndo(note.id);
    } finally {
      database.noteUndoReady = true;
    }
  });

  await t.test("real account scope hides and refuses another account's recovery", async () => {
    database.setActiveAccountId("account-one");
    const note = fresh();
    await edit(note, { title: "Account one edit" });
    const token = tokenFor(note.id);
    assert.ok(token);
    database.setActiveAccountId("account-two");
    assert.equal(database.getNote(note.id), null);
    assert.equal(tokenFor(note.id), undefined);
    assert.equal(database.claimNoteUndo(token), false);
    assert.equal(database.undoNoteUpdate(token).success, false);
    database.setActiveAccountId("account-one");
    assert.equal(database.undoNoteUpdate(token).success, true);
    database.setActiveAccountId(null);
  });

  await t.test(
    "recovery remains bound to the originating account even for a shared local note",
    async () => {
      database.setActiveAccountId(null);
      const note = fresh();
      await edit(note, { title: "Signed-out edit" });
      const token = tokenFor(note.id);
      database.setActiveAccountId("another-account");
      assert.ok(database.getNote(note.id), "legacy local note remains readable by design");
      assert.equal(tokenFor(note.id), undefined);
      assert.equal(database.undoNoteUpdate(token).success, false);
      database.setActiveAccountId(null);
      assert.equal(database.undoNoteUpdate(token).success, true);
      assert.equal(database.getNote(note.id).title, note.title);
    }
  );

  await t.test("concurrent changes before commit fail truthfully", async () => {
    const note = fresh();
    const stub = t.mock.method(
      globalThis.window.electronAPI,
      "updateNote",
      async (id, updates, options) => {
        database.updateNote(id, { content: "Concurrent edit" });
        return database.updateNote(id, updates, options);
      }
    );
    const result = await edit(note, { summary: "New summary" });
    stub.mock.restore();
    assert.equal(result.success, false);
    assert.match(result.displayText, /Note changed/);
    assert.equal(database.getNote(note.id).content, "Concurrent edit");
    assert.equal(database.getNote(note.id).enhanced_content, note.enhanced_content);
    assert.equal(tokenFor(note.id), undefined);
  });

  await t.test("deleted previous folder and account switch cannot restore", async () => {
    const note = fresh();
    const folder = database.createFolder(`Original ${note.id}`, note.space_id).folder;
    database.updateNote(note.id, { folder_id: folder.id });
    await edit(note, { folder: `New ${note.id}` });
    const token = tokenFor(note.id);
    database.db.prepare("UPDATE folders SET deleted_at = '2026-10-09' WHERE id = ?").run(folder.id);
    assert.equal(database.undoNoteUpdate(token).success, false);
    const accountNote = fresh();
    await edit(accountNote, { title: "Changed" });
    const accountToken = tokenFor(accountNote.id);
    const scoped = t.mock.method(database, "getNote", () => null);
    assert.equal(database.undoNoteUpdate(accountToken).success, false);
    scoped.mock.restore();
    assert.equal(database.getNote(accountNote.id).title, "Changed");
  });
});
