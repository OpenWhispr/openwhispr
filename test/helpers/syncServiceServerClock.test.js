// Delta pulls ask the server for rows updated after the stored cursor, and the
// server compares that against its own updated_at. A cursor stamped on a
// device clock that runs fast sits ahead of every row written since, so that
// device stops receiving its teammates' notes. Cursors are stamped on the
// server's clock, read from its Date header.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { resetServerClock } = require("../../src/lib/serverClock.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The device clock is real time; the server's runs `behindMs` behind it.
async function setup(t, behindMs) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  resetServerClock();
  enableSync();
  const cloud = createFakeCloud({ serverDate: true });
  const server = { offsetMs: -behindMs };
  cloud.setClock(() => new Date(Date.now() + server.offsetMs).toISOString());
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => {
    stopSyncTimers(service);
    resetServerClock();
  });
  const serverIso = (shiftMs = 0) => new Date(Date.now() + server.offsetMs + shiftMs).toISOString();
  return { db, cloud, service, serverIso };
}

function localByClientId(db, clientNoteId) {
  return db.db.prepare("SELECT * FROM notes WHERE client_note_id = ?").get(clientNoteId);
}

test("a device whose clock runs an hour fast still pulls a teammate's later note", async (t) => {
  const ctx = await setup(t, HOUR);
  if (!ctx) return;
  const { db, cloud, service, serverIso } = ctx;

  await service.syncAll(true);
  const cursor = localStorageStub.getItem("lastSyncedAt.notes");
  assert.ok(
    Date.parse(cursor) <= Date.parse(serverIso()),
    "the cursor is a time the server has already reached"
  );

  // A teammate writes a note a minute later, by the server's clock.
  cloud.seedNote({
    client_note_id: "teammate-note",
    title: "From the teammate",
    content: "hello",
    created_at: serverIso(MINUTE),
    updated_at: serverIso(MINUTE),
  });
  await service.syncAll(true);

  assert.equal(localByClientId(db, "teammate-note")?.content, "hello");
});

test("a fast clock's old cursor is dropped once so the notes it hid arrive", async (t) => {
  const ctx = await setup(t, HOUR);
  if (!ctx) return;
  const { db, cloud, service, serverIso } = ctx;

  // A synced device on an older build: its cursors came from its own clock,
  // an hour ahead, so a row the server stamped ten minutes ago sits behind it.
  const oldCursor = new Date(Date.now() - 5 * MINUTE).toISOString();
  for (const key of ["lastSyncedAt.notes", "lastSyncedAt.folders"]) {
    localStorageStub.setItem(key, oldCursor);
  }
  localStorageStub.setItem("noteFeedReplay.v1", "3");
  cloud.seedNote({
    client_note_id: "hidden-note",
    title: "Written while the clock was wrong",
    content: "missed",
    created_at: serverIso(-10 * MINUTE),
    updated_at: serverIso(-10 * MINUTE),
  });

  await service.syncAll(true);

  assert.equal(localByClientId(db, "hidden-note")?.content, "missed");
  const cursor = localStorageStub.getItem("lastSyncedAt.notes");
  assert.ok(Date.parse(cursor) <= Date.parse(serverIso()), "the new cursor is on the server clock");

  // Once restamped, the cursor is kept: no second full read.
  const listsBefore = cloud.logFor("/api/notes/list").length;
  await service.syncAll(true);
  const lists = cloud.logFor("/api/notes/list").slice(listsBefore);
  assert.ok(lists.length > 0);
  assert.ok(
    lists.every((call) => new URL(call.path, "https://x").searchParams.get("since")),
    "later pulls are deltas from the kept cursor"
  );
});

test("a device on time keeps the cursors it already has", async (t) => {
  const ctx = await setup(t, 0);
  if (!ctx) return;
  const { cloud, service } = ctx;

  const kept = new Date(Date.now() - 5 * MINUTE).toISOString();
  localStorageStub.setItem("lastSyncedAt.notes", kept);
  localStorageStub.setItem("noteFeedReplay.v1", "3");

  await service.syncAll(true);

  const firstList = cloud.logFor("/api/notes/list")[0];
  assert.equal(new URL(firstList.path, "https://x").searchParams.get("since"), kept);
});
