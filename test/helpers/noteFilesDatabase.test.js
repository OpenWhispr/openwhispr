// The mirror against the real database, for what a stand-in can't show: the real
// rows, account scoping and soft deletes. Skips where the native binding is built
// for Electron; run with ELECTRON_RUN_AS_NODE=1 npx electron --test <this file>.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

  db.moveFolderToSpace(betaFolder.id, acme);
  noteFiles.containersChanged();
  await noteFiles.flush();
  assert.equal(dirOf(basePath, betaNote.id), "Workspaces/Acme/Teamspaces/Engineering/General");

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
