const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-rename-db-"));

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const sent = [];

const electronStub = {
  app: {
    getPath: () => userDataDir,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [
        {
          isDestroyed: () => false,
          webContents: { send: (channel, data) => sent.push([channel, data]) },
        },
      ];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: { openPath: async () => "" },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

const DatabaseManager = require("../../src/helpers/database");
const IPCHandlers = require(handlersModulePath);
const mirror = require("../../src/helpers/markdownMirror");
let db;
let mirrorDir;
let target;
test.before(() => {
  db = new DatabaseManager();
  db.setActiveAccountId("test-account");
  mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-rename-files-"));
  mirror.init(mirrorDir);
  const Ctor = IPCHandlers.default || IPCHandlers;
  target = new Proxy(
    {
      databaseManager: db,
      _noteFilesEnabled: true,
      _getFolderName: Ctor.prototype._getFolderName,
      _asyncMirrorWrite: Ctor.prototype._asyncMirrorWrite,
      _mirrorDeleteFolderIfUnshared: Ctor.prototype._mirrorDeleteFolderIfUnshared,
      _buildSpeakerMappings: Ctor.prototype._buildSpeakerMappings,
    },
    { get: (value, key) => (key in value ? value[key] : anything()) }
  );
  Ctor.prototype.setupHandlers.call(target);
});
test.after(() => {
  db?.db?.close();
  Module._load = originalLoad;
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(mirrorDir, { recursive: true, force: true });
});
function teamSpace(name) {
  const result = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order) VALUES (?, 'team', ?, 10)"
    )
    .run(name, name);
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(result.lastInsertRowid, "test-account");
  return result.lastInsertRowid;
}
function note(folder, title) {
  const n = db.saveNote(
    title,
    title + " body",
    "meeting",
    null,
    null,
    folder.id,
    folder.space_id
  ).note;
  db.db
    .prepare("UPDATE notes SET transcript = ? WHERE id = ?")
    .run(JSON.stringify([{ speaker: "A", text: title + " transcript", start: 0, end: 1 }]), n.id);
  const complete = db.getNote(n.id);
  db.setSpeakerMapping(n.id, "A", null, title + " speaker");
  mirror.writeNote(complete, folder.name);
  mirror.writeTranscript(complete, folder.name, { A: title + " speaker" });
  return complete;
}
async function rename(id, name) {
  const result = await handlers.get("db-rename-folder")(null, id, name);
  await new Promise((resolve) => setImmediate(resolve));
  return result;
}
test("renaming one space's folder leaves another space's mirrored notes and transcripts in place", async () => {
  const a = db.createFolder("Projects", db.getPrivateSpaceId()).folder;
  const b = db.createFolder("Projects", teamSpace("Team B")).folder;
  const moved = note(a, "Moved meeting");
  const kept = note(b, "Kept meeting");
  const keptPath = mirror.getNotePath(kept.id);
  const keptTranscript = keptPath.replace(/\.md$/, "-transcript.md");
  assert.ok(fs.existsSync(keptTranscript));
  assert.equal((await rename(a.id, "Archive")).success, true);
  console.log(
    JSON.stringify({
      keptPath,
      actualKeptPath: mirror.getNotePath(kept.id),
      movedPath: mirror.getNotePath(moved.id),
      folderB: db.db.prepare("SELECT name FROM folders WHERE id = ?").get(b.id).name,
      showOriginalFolder: await handlers.get("show-folder-in-explorer")(null, "Projects"),
    })
  );
  assert.equal(mirror.getNotePath(kept.id), keptPath);
  assert.ok(fs.existsSync(keptTranscript));
  assert.equal(path.basename(path.dirname(mirror.getNotePath(moved.id))), "Archive");
  assert.equal((await handlers.get("show-folder-in-explorer")(null, "Projects")).success, true);
});
test("renaming a uniquely named folder moves its own mirrored files", async () => {
  const folder = db.createFolder("Unique", db.getPrivateSpaceId()).folder;
  const n = note(folder, "Unique meeting");
  assert.equal((await rename(folder.id, "Unique archive")).success, true);
  assert.equal(path.basename(path.dirname(mirror.getNotePath(n.id))), "Unique archive");
  assert.ok(fs.existsSync(mirror.getNotePath(n.id).replace(/\.md$/, "-transcript.md")));
});

test("deleting the renamed folder preserves another space's note files", async () => {
  const a = db.createFolder("Shared", db.getPrivateSpaceId()).folder;
  const b = db.createFolder("Shared", teamSpace("Team C")).folder;
  note(a, "Deleted meeting");
  const kept = note(b, "Retained meeting");
  await rename(a.id, "Completed");
  assert.equal((await handlers.get("db-delete-folder")(null, a.id)).success, true);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(
    JSON.stringify({
      survivingDatabaseNote: Boolean(db.getNote(kept.id)),
      survivingMirrorFile: mirror.getNotePath(kept.id),
    })
  );
  assert.ok(db.getNote(kept.id));
  assert.ok(mirror.getNotePath(kept.id), "unrelated live note keeps its mirrored output");
});

function transcriptText(n) {
  return fs.readFileSync(mirror.getNotePath(n.id).replace(/\.md$/, "-transcript.md"), "utf8");
}
function flushMirrors() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("an existing destination keeps its files while only the renamed folder's children move", async () => {
  const source = db.createFolder("Source collision", db.getPrivateSpaceId()).folder;
  const sibling = db.createFolder("Source collision", teamSpace("Collision source team")).folder;
  const destination = db.createFolder(
    "Destination collision",
    teamSpace("Collision destination team")
  ).folder;
  const moved = note(source, "Collision moved");
  const kept = note(sibling, "Collision kept");
  const destinationNote = note(destination, "Destination kept");
  const keptPath = mirror.getNotePath(kept.id);
  const destinationPath = mirror.getNotePath(destinationNote.id);
  const keptBytes = fs.readFileSync(keptPath, "utf8");
  const destinationBytes = fs.readFileSync(destinationPath, "utf8");
  assert.equal((await rename(source.id, destination.name)).success, true);
  assert.equal(path.dirname(mirror.getNotePath(moved.id)), path.dirname(destinationPath));
  assert.equal(fs.readFileSync(keptPath, "utf8"), keptBytes);
  assert.equal(fs.readFileSync(destinationPath, "utf8"), destinationBytes);
  assert.match(transcriptText(moved), /Collision moved transcript/);
  assert.match(transcriptText(moved), /Collision moved speaker/);
});

test("foreign-account children follow their folder but same-named foreign folders do not", async () => {
  const source = db.createFolder("Account shared", db.getPrivateSpaceId()).folder;
  const child = note(source, "Foreign child");
  const childBytes = fs.readFileSync(mirror.getNotePath(child.id), "utf8");
  const childTranscriptBytes = transcriptText(child);
  db.db.prepare("UPDATE notes SET account_id = ? WHERE id = ?").run("other-account", child.id);
  db.setActiveAccountId("other-account");
  const foreignFolder = db.createFolder("Account shared", db.getPrivateSpaceId()).folder;
  const unrelated = note(foreignFolder, "Foreign unrelated");
  const unrelatedPath = mirror.getNotePath(unrelated.id);
  const unrelatedBytes = fs.readFileSync(unrelatedPath, "utf8");
  db.setActiveAccountId("test-account");
  assert.equal((await rename(source.id, "Account archive")).success, true);
  assert.equal(path.basename(path.dirname(mirror.getNotePath(child.id))), "Account archive");
  assert.equal(fs.readFileSync(mirror.getNotePath(child.id), "utf8"), childBytes);
  assert.equal(transcriptText(child), childTranscriptBytes);
  assert.match(transcriptText(child), /Foreign child transcript/);
  assert.match(transcriptText(child), /Foreign child speaker/);
  assert.equal(fs.readFileSync(unrelatedPath, "utf8"), unrelatedBytes);
  assert.equal(
    db.db.prepare("SELECT account_id FROM notes WHERE id = ?").get(child.id).account_id,
    "other-account"
  );
  assert.equal(
    db.db.prepare("SELECT folder_id FROM notes WHERE id = ?").get(unrelated.id).folder_id,
    foreignFolder.id
  );
});

test("queued renames use the latest live folder while preserving existing file bytes", async () => {
  const folder = db.createFolder("Queued original", db.getPrivateSpaceId()).folder;
  const n = note(folder, "Queued meeting");
  const notePath = mirror.getNotePath(n.id);
  const transcriptPath = notePath.replace(/\.md$/, "-transcript.md");
  fs.appendFileSync(notePath, "\nExternal note edit");
  fs.appendFileSync(transcriptPath, "\nExternal transcript edit");
  const noteBytes = fs.readFileSync(notePath, "utf8");
  const transcriptBytes = fs.readFileSync(transcriptPath, "utf8");
  await handlers.get("db-rename-folder")(null, folder.id, "Queued intermediate");
  await handlers.get("db-rename-folder")(null, folder.id, "  Queued final  ");
  await flushMirrors();
  assert.equal(path.basename(path.dirname(mirror.getNotePath(n.id))), "Queued final");
  assert.equal(fs.readFileSync(mirror.getNotePath(n.id), "utf8"), noteBytes);
  assert.equal(transcriptText(n), transcriptBytes);
  assert.equal(fs.existsSync(path.join(mirrorDir, "Queued intermediate")), false);
});

test("deleted folders and changed account scopes are not remirrored by queued callbacks", async () => {
  const deleted = db.createFolder("Queued deleted", db.getPrivateSpaceId()).folder;
  note(deleted, "Deleted queued meeting");
  await handlers.get("db-rename-folder")(null, deleted.id, "Deleted destination");
  db.deleteFolder(deleted.id);
  await flushMirrors();
  assert.equal(fs.existsSync(path.join(mirrorDir, "Deleted destination")), false);
  const switched = db.createFolder("Queued account", db.getPrivateSpaceId()).folder;
  const switchedNote = note(switched, "Switched queued meeting");
  const switchedPath = mirror.getNotePath(switchedNote.id);
  await handlers.get("db-rename-folder")(null, switched.id, "Account destination");
  db.setActiveAccountId("other-account");
  await flushMirrors();
  db.setActiveAccountId("test-account");
  assert.equal(fs.existsSync(path.join(mirrorDir, "Account destination")), false);
  assert.equal(mirror.getNotePath(switchedNote.id), switchedPath);
});

test("empty folder renames create the normalized destination and rejected renames preserve files", async () => {
  const empty = db.createFolder("Empty original", db.getPrivateSpaceId()).folder;
  mirror.ensureFolder(empty.name);
  assert.equal((await rename(empty.id, "  Empty destination  ")).success, true);
  assert.equal(fs.existsSync(path.join(mirrorDir, "Empty destination")), true);
  assert.equal(fs.existsSync(path.join(mirrorDir, "Empty original")), false);
  const folder = db.createFolder("Rejected original", db.getPrivateSpaceId()).folder;
  const n = note(folder, "Rejected meeting");
  const before = mirror.getNotePath(n.id);
  const beforeBytes = fs.readFileSync(before, "utf8");
  assert.equal((await rename(folder.id, "Empty destination")).success, false);
  assert.equal(fs.readFileSync(before, "utf8"), beforeBytes);
  target._noteFilesEnabled = false;
  try {
    assert.equal((await rename(folder.id, "Disabled destination")).success, true);
    assert.equal(mirror.getNotePath(n.id), before);
    assert.equal(fs.existsSync(path.join(mirrorDir, "Disabled destination")), false);
  } finally {
    target._noteFilesEnabled = true;
  }
});

test("a destination file collision preserves both copies and prevents old-directory cleanup", async () => {
  const folder = db.createFolder("Collision original", db.getPrivateSpaceId()).folder;
  const n = note(folder, "Collision copies");
  const oldPath = mirror.getNotePath(n.id);
  const oldBytes = fs.readFileSync(oldPath, "utf8");
  const destinationName = "Collision conflicting destination";
  mirror.ensureFolder(destinationName);
  const conflictPath = path.join(mirrorDir, destinationName, path.basename(oldPath));
  fs.writeFileSync(conflictPath, "---\nid: " + n.id + "\n---\nExisting external copy");
  const conflictBytes = fs.readFileSync(conflictPath, "utf8");
  assert.equal((await rename(folder.id, destinationName)).success, true);
  assert.equal(fs.readFileSync(oldPath, "utf8"), oldBytes);
  assert.equal(fs.readFileSync(conflictPath, "utf8"), conflictBytes);
});

test("rename cleanup preserves another folder with a case-equivalent physical path", async (t) => {
  const a = db.createFolder("CaseProjects", db.getPrivateSpaceId()).folder;
  const b = db.createFolder("caseprojects", teamSpace("Case team")).folder;
  const moved = note(a, "Case moved");
  const kept = note(b, "Case kept");
  const keptPath = mirror.getNotePath(kept.id);
  const caseA = fs.statSync(path.join(mirrorDir, "CaseProjects"));
  const caseB = fs.statSync(path.join(mirrorDir, "caseprojects"));
  if (caseA.ino !== caseB.ino) return t.skip("filesystem is case-sensitive");
  const keptBytes = fs.readFileSync(keptPath, "utf8");
  assert.equal((await rename(a.id, "Case archive")).success, true);
  console.log(
    JSON.stringify({
      caseInsensitive: true,
      liveSiblingNote: Boolean(db.getNote(kept.id)),
      keptPath,
      keptFileExists: fs.existsSync(keptPath),
      movedPath: mirror.getNotePath(moved.id),
    })
  );
  assert.ok(fs.existsSync(keptPath), "another live folder's mirror must survive cleanup");
  assert.equal(fs.readFileSync(keptPath, "utf8"), keptBytes);
});

test("rename cleanup preserves external files in the old directory", async () => {
  const folder = db.createFolder("External original", db.getPrivateSpaceId()).folder;
  note(folder, "External meeting");
  const externalPath = path.join(mirrorDir, folder.name, "personal-attachment.txt");
  fs.writeFileSync(externalPath, "User-owned external attachment");
  assert.equal((await rename(folder.id, "External archive")).success, true);
  console.log(JSON.stringify({ externalPath, externalFileExists: fs.existsSync(externalPath) }));
  assert.ok(fs.existsSync(externalPath), "cleanup must preserve non-note files");
});
