// The mirror against the real database, for what a stand-in can't show: the real
// rows, account scoping and soft deletes. Skips where the native binding is built
// for Electron; run with ELECTRON_RUN_AS_NODE=1 npx electron --test <this file>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");

let userDataDir;
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getName: () => "test",
        getVersion: () => "0.0.0",
        isPackaged: false,
        on: () => {},
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let DatabaseManager;
let createNoteFilesSync;
try {
  DatabaseManager = require("../../src/helpers/database");
  ({ createNoteFilesSync } = require("../../src/helpers/noteFilesSync"));
} finally {
  Module._load = originalLoad;
}

function setup(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-note-files-db-"));
  const basePath = path.join(userDataDir, "notes");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    t.skip(`better-sqlite3 isn't built for this runtime: ${error.message}`);
    return null;
  }
  t.after(() => db.db.close());
  db.setActiveAccountId("account-a");
  const noteFiles = createNoteFilesSync({ getDatabase: () => db, getSpeakerMappings: () => ({}) });
  t.after(() => noteFiles.disable());
  return { db, noteFiles, basePath };
}

function teamSpace(db, name, workspaceId) {
  const { lastInsertRowid: id } = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
    )
    .run(`client-${name}-${workspaceId}`, name, workspaceId);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(id, "account-a");
  return id;
}

const saveNote = (db, title, folderId, spaceId) =>
  db.saveNote(title, `${title} body`, "personal", null, null, folderId, spaceId).note;

function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? allFiles(entryPath) : [entryPath];
  });
}

function dirOf(basePath, noteId) {
  const matches = allFiles(basePath).filter((file) => path.basename(file).startsWith(`${noteId}-`));
  assert.equal(matches.length, 1, `note ${noteId}: ${matches}`);
  return path.relative(basePath, path.dirname(matches[0])).split(path.sep).join("/");
}

test("real rows land in the layout and follow renames, moves and deletes", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  db.setWorkspaceNames([
    { id: "w-1", name: "Acme" },
    { id: "w-2", name: "Beta" },
  ]);
  const acme = teamSpace(db, "Engineering", "w-1");
  const beta = teamSpace(db, "Engineering", "w-2");
  const acmeFolder = db.createFolder("General", acme).folder;
  const betaFolder = db.createFolder("General", beta).folder;
  const privateFolder = db.createFolder("General").folder;
  const acmeNote = saveNote(db, "Acme retro", acmeFolder.id, acme);
  const betaNote = saveNote(db, "Beta retro", betaFolder.id, beta);
  const rootNote = saveNote(db, "Root", null, acme);
  const privateNote = saveNote(db, "Mine", privateFolder.id, null);

  await noteFiles.enable(basePath);

  assert.equal(dirOf(basePath, acmeNote.id), "Workspaces/Acme/Teamspaces/Engineering/General");
  assert.equal(dirOf(basePath, betaNote.id), "Workspaces/Beta/Teamspaces/Engineering/General");
  assert.equal(dirOf(basePath, rootNote.id), "Workspaces/Acme/Teamspaces/Engineering");
  assert.equal(dirOf(basePath, privateNote.id), "Private notes/General");

  db.renameFolder(acmeFolder.id, "Archive");
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(dirOf(basePath, acmeNote.id), "Workspaces/Acme/Teamspaces/Engineering/Archive");
  assert.equal(dirOf(basePath, betaNote.id), "Workspaces/Beta/Teamspaces/Engineering/General");

  const rejected = db.moveFolderToSpace(betaFolder.id, acme);
  assert.equal(rejected.success, false, "a team move cannot cross workspace boundaries");
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(dirOf(basePath, betaNote.id), "Workspaces/Beta/Teamspaces/Engineering/General");

  const betaDesign = teamSpace(db, "Design", "w-2");
  const moved = db.moveFolderToSpace(betaFolder.id, betaDesign);
  assert.equal(moved.success, true);
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(dirOf(basePath, betaNote.id), "Workspaces/Beta/Teamspaces/Design/General");

  const { noteIds } = db.deleteFolder(acmeFolder.id);
  assert.deepEqual(noteIds, [acmeNote.id]);
  for (const noteId of noteIds) noteFiles.deleteNote(noteId);
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(
    allFiles(basePath).some((file) => path.basename(file).startsWith(`${acmeNote.id}-`)),
    false
  );
  assert.equal(
    fs.existsSync(path.join(basePath, "Workspaces/Acme/Teamspaces/Engineering/Archive")),
    false
  );
  assert.equal(
    db.getMirrorFiles(fs.realpathSync(basePath), acmeNote.id).length,
    0,
    "the record forgets removed files"
  );
});

test("the mirror keeps an edit made outside the app when it writes the note again", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  const note = saveNote(db, "Kept", null, null);
  await noteFiles.enable(basePath);
  const dir = path.join(basePath, dirOf(basePath, note.id));
  fs.appendFileSync(path.join(dir, `${note.id}-kept.md`), "\nmine");

  db.updateNote(note.id, { title: "Renamed" });
  noteFiles.writeNote(db.getNote(note.id));
  await noteFiles.flush();

  assert.match(fs.readFileSync(path.join(dir, `edited-${note.id}-kept.md`), "utf8"), /mine$/);
  assert.equal(fs.existsSync(path.join(dir, `${note.id}-renamed.md`)), true);
});

test("startup removes a recorded empty upload companion and reveals its transcript", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  const note = db.saveNote(
    "Uploaded audio",
    "",
    "upload",
    null,
    null,
    null,
    null,
    JSON.stringify([{ text: "A recorded transcript." }])
  ).note;
  await noteFiles.enable(basePath);
  const transcriptPath = noteFiles.notePath(note.id);
  const companionPath = path.join(path.dirname(transcriptPath), `${note.id}-uploaded-audio.md`);
  const contents = `---\nid: ${note.id}\ntitle: "Uploaded audio"\ntype: upload\nspace: "Private"\nfolder: "Personal"\ncreated: ${note.created_at}\nupdated: ${note.updated_at}\n---\n\n`;
  // Seed the recorded pair written before transcript-only exports were supported.
  fs.writeFileSync(companionPath, contents);
  db.recordMirrorFile(fs.realpathSync(basePath), {
    relPath: path.relative(basePath, companionPath).split(path.sep).join("/"),
    ownerId: note.id,
    kind: "note",
    hash: crypto.createHash("sha256").update(contents).digest("hex"),
  });

  noteFiles.disable();
  await noteFiles.enable(basePath, { skipRebuild: true });
  await noteFiles.flush();

  assert.equal(fs.existsSync(companionPath), false);
  assert.equal(noteFiles.notePath(note.id), transcriptPath);
  assert.deepEqual(allFiles(basePath), [transcriptPath]);
});

test("unrelated folder changes and restart leave an edited upload transcript in place", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  const note = db.saveNote(
    "Uploaded audio",
    "",
    "upload",
    null,
    null,
    null,
    null,
    JSON.stringify([{ text: "A recorded transcript." }])
  ).note;
  await noteFiles.enable(basePath);
  const transcriptPath = noteFiles.notePath(note.id);
  const edited = `${fs.readFileSync(transcriptPath, "utf8")}\nExternal correction.`;
  fs.writeFileSync(transcriptPath, edited);

  db.createFolder("Unrelated");
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(fs.readFileSync(transcriptPath, "utf8"), edited);
  assert.deepEqual(allFiles(basePath), [transcriptPath]);

  noteFiles.disable();
  await noteFiles.enable(basePath, { skipRebuild: true });
  await noteFiles.flush();
  assert.equal(fs.readFileSync(transcriptPath, "utf8"), edited);
  assert.deepEqual(allFiles(basePath), [transcriptPath]);
});

test("mirror summaries distinguish transcript-only uploads from notes, drafts and empty transcripts", (t) => {
  const context = setup(t);
  if (!context) return;
  const { db } = context;
  const transcript = JSON.stringify([{ text: "Spoken words" }]);
  const cases = [
    { name: "upload", expected: 1 },
    { name: "notes", content: "Notes", expected: 0 },
    { name: "summary", enhanced_content: "Summary", expected: 0 },
    {
      name: "whitespace",
      content:
        "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f",
      enhanced_content: "\ufeff\u3000",
      expected: 1,
    },
    { name: "zero-width content", content: "\u200b", expected: 0 },
    { name: "NUL content", content: "\0", expected: 0 },
    { name: "personal", note_type: "personal", expected: 0 },
    { name: "meeting", note_type: "meeting", expected: 0 },
    { name: "draft", transcript: null, expected: 0 },
    { name: "empty array", transcript: "[]", expected: 0 },
    {
      name: "blank transcript",
      transcript: JSON.stringify([{ text: "\n\u00a0\ufeff" }]),
      expected: 0,
    },
    {
      name: "later text",
      transcript: JSON.stringify([{ text: "" }, { text: "Spoken words" }]),
      expected: 1,
    },
    { name: "invalid JSON", transcript: "invalid", expected: 0 },
    { name: "object", transcript: JSON.stringify({ text: "Spoken words" }), expected: 0 },
    {
      name: "primitive segments",
      transcript: JSON.stringify(["Spoken words", null, 1]),
      expected: 0,
    },
  ];
  const rows = cases.map((fields) => {
    const note = db.saveNote(fields.name, "", fields.note_type || "upload").note;
    db.db
      .prepare("UPDATE notes SET content = ?, enhanced_content = ?, transcript = ? WHERE id = ?")
      .run(
        fields.content ?? "",
        fields.enhanced_content ?? "",
        "transcript" in fields ? fields.transcript : transcript,
        note.id
      );
    return { id: note.id, ...fields };
  });
  const summaries = db.getMirrorNoteSummaries();
  for (const row of rows) {
    const summary = summaries.find((candidate) => candidate.id === row.id);
    assert.equal(summary.is_transcript_only_upload, row.expected, row.name);
  }
});

test("the old layout moves over without touching another account's files", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  const folder = db.createFolder("General").folder;
  const mine = saveNote(db, "Mine", folder.id, null);
  db.setActiveAccountId("account-b");
  const theirFolder = db.createFolder("General").folder;
  const theirs = saveNote(db, "Theirs", theirFolder.id, null);
  db.setActiveAccountId("account-a");

  const legacyDir = path.join(basePath, "General");
  fs.mkdirSync(legacyDir, { recursive: true });
  const old = (note) =>
    `---\nid: ${note.id}\ntitle: ${note.title}\ntype: personal\nfolder: General\ncreated: ${note.created_at}\nupdated: y\n---\n\n${note.content}`;
  fs.writeFileSync(path.join(legacyDir, `${mine.id}-mine.md`), old(mine));
  const theirFile = path.join(legacyDir, `${theirs.id}-theirs.md`);
  fs.writeFileSync(theirFile, old(theirs));

  await noteFiles.enable(basePath, { skipRebuild: true });
  await noteFiles.flush();

  assert.equal(dirOf(basePath, mine.id), "Private notes/General");
  assert.equal(fs.readFileSync(theirFile, "utf8"), old(theirs));
  assert.equal(fs.existsSync(path.join(legacyDir, `${mine.id}-mine.md`)), false);

  db.setActiveAccountId("account-b");
  noteFiles.accountChanged();
  await noteFiles.flush();

  assert.equal(dirOf(basePath, theirs.id), "Private notes/General");
  assert.equal(fs.existsSync(legacyDir), false);
});

function duplicateCopies(db) {
  const first = db.saveNote("Same", "body", "personal").note;
  const second = db.saveNote("Same", "body", "personal").note;
  db.db
    .prepare(
      "UPDATE notes SET cloud_id = 'X', sync_status = 'synced', account_id = 'account-a' WHERE id IN (?, ?)"
    )
    .run(first.id, second.id);
  return [first, second];
}

test("a merge that rolls back reports no copies as removed", (t) => {
  const context = setup(t);
  if (!context) return;
  const { db } = context;
  duplicateCopies(db);
  db.db.exec(
    "CREATE TEMP TRIGGER fail_merge BEFORE UPDATE OF share_token ON notes BEGIN SELECT RAISE(ABORT, 'simulated'); END"
  );

  const removed = [];
  db.mergeDuplicateCloudNotes(removed);

  assert.deepEqual(removed, []);
});

test("a merged copy carries its speaker names, which the merge moves away", (t) => {
  const context = setup(t);
  if (!context) return;
  const { db } = context;
  const copies = duplicateCopies(db);
  for (const copy of copies) db.setSpeakerMapping(copy.id, "speaker_0", null, "Ada");

  const removed = [];
  db.mergeDuplicateCloudNotes(removed);

  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].speakerMappings, { speaker_0: "Ada" });
});

test("deletion snapshots include scoped tombstones and exclude another account's bodies", (t) => {
  const context = setup(t);
  if (!context) return;
  const { db } = context;
  const folder = db.createFolder("General").folder;
  const mine = saveNote(db, "Mine", folder.id, null);
  db.db.prepare("UPDATE notes SET deleted_at = 'now' WHERE id = ?").run(mine.id);
  db.setActiveAccountId("account-b");
  const theirs = saveNote(db, "Theirs", null, null);
  db.setActiveAccountId("account-a");

  for (const filter of [
    { folder_id: folder.id },
    { space_id: mine.space_id },
    { account_id: "account-a" },
  ]) {
    const snapshots = db.getNotesForMirrorDeletion(filter);
    assert.deepEqual(
      snapshots.map((note) => note.id),
      [mine.id]
    );
    assert.equal(snapshots[0].content, "Mine body");
    assert.equal(snapshots[0].deleted_at, "now");
  }
  assert.deepEqual(db.getNotesForMirrorDeletion({ account_id: "account-b" }), []);
  assert.equal(db.getNotesForMirror([theirs.id]).length, 0);
});

test("startup cleans a deleted note in a soft-deleted dot-prefixed app folder", async (t) => {
  const context = setup(t);
  if (!context) return;
  const { db, noteFiles, basePath } = context;
  const folder = db.createFolder(".archive").folder;
  const note = saveNote(db, "Gone", folder.id, null);
  db.db.prepare("UPDATE notes SET deleted_at = 'now' WHERE id = ?").run(note.id);
  db.db.prepare("UPDATE folders SET deleted_at = 'now' WHERE id = ?").run(folder.id);
  db.setActiveAccountId("account-b");
  db.createFolder(".other-account");
  db.setActiveAccountId("account-a");
  assert.ok(db.getLegacyMirrorFolderNames().includes(".other-account"));
  const oldPath = path.join(basePath, ".archive", `${note.id}-gone.md`);
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(
    oldPath,
    `---\nid: ${note.id}\ntitle: Gone\ntype: personal\nfolder: .archive\n---\n\n${note.content}`
  );

  await noteFiles.enable(basePath, { skipRebuild: true });
  await noteFiles.flush();

  assert.equal(fs.existsSync(oldPath), false);
});
