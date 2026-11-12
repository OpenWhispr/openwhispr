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
const { createFakeCloud, createAccountCloud } = require("./harness/fakeCloud.js");
const { joinTeamSpace } = require("./harness/teamSpace.js");
const { createSyncDevice } = require("./harness/syncDevice.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { resetServerClockForTests } = require("../../src/lib/serverClock.ts");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The device clock is real time; the server's runs `behindMs` behind it.
async function setup(t, behindMs) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  resetServerClockForTests();
  enableSync();
  const cloud = createFakeCloud({ serverDate: true });
  const server = { offsetMs: -behindMs };
  cloud.setClock(() => new Date(Date.now() + server.offsetMs).toISOString());
  joinTeamSpace(db, cloud);
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => {
    stopSyncTimers(service);
    resetServerClockForTests();
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

test("a fast clock's old cursors still bring the deletes made since they were stamped", async (t) => {
  const ctx = await setup(t, HOUR);
  if (!ctx) return;
  const { db, cloud, service, serverIso } = ctx;

  const at = serverIso(-3 * HOUR);
  // This chat originated locally and can follow remote deletes; restored chats stay local.
  const localChat = db.createAgentConversation("Chat");
  db.addAgentMessage(localChat.id, "user", "hello");
  const local = db.getAgentConversation(localChat.id);
  assert.equal(local.device_only, 0);
  const chat = cloud.seedConversation({
    title: "Chat",
    client_conversation_id: local.client_conversation_id,
    created_at: at,
    updated_at: at,
  });
  const dictation = cloud.seedTranscription({
    text: "Dictation",
    client_transcription_id: "dictation",
    created_at: at,
    updated_at: at,
  });
  await service.syncAll(true);
  assert.equal(db.getAgentConversation(localChat.id).cloud_id, chat.id);
  assert.ok(db.getConversationByClientId(local.client_conversation_id));
  assert.ok(db.getTranscriptionByClientId("dictation"));

  // An older build pulled two hours ago by the device's clock. Without a
  // cursor these pulls list live rows only, so the deletes since would be lost.
  localStorageStub.removeItem("syncCursors.serverClock");
  const oldCursor = new Date(Date.now() - 2 * HOUR).toISOString();
  localStorageStub.setItem("lastSyncedAt.conversations", oldCursor);
  localStorageStub.setItem("lastSyncedAt.transcriptions", oldCursor);
  cloud.deleteConversation(chat.id);
  cloud.deleteTranscription(dictation.id);

  await service.syncAll(true);

  assert.equal(db.getConversationByClientId(local.client_conversation_id) ?? null, null);
  assert.equal(db.getTranscriptionByClientId("dictation") ?? null, null);
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

test("restoring another account's old cursors still recovers rows missed by a fast clock", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  resetServerClockForTests();
  t.after(resetServerClockForTests);
  const serverIso = (shiftMs = 0) => new Date(Date.now() - HOUR + shiftMs).toISOString();
  const cloudA = createAccountCloud({ serverDate: true });
  const cloudB = createAccountCloud({ serverDate: true });
  cloudA.setClock(() => serverIso());
  cloudB.setClock(() => serverIso());

  // B last synced two device-clock hours ago. Its cursor is no longer ahead
  // of the server, but still skips the hour of writes its fast clock hid.
  localStorageStub.setItem(
    "lastSyncedAt.byAccount.account-b",
    JSON.stringify({ "lastSyncedAt.conversations": serverIso(-HOUR) })
  );
  cloudB.seedConversation({
    client_conversation_id: "missed-chat",
    title: "Missed while the clock was fast",
    created_at: serverIso(-90 * MINUTE),
    updated_at: serverIso(-90 * MINUTE),
  });
  await device.signIn("account-a", cloudA);
  await device.service.syncAll(true);
  await device.signIn("account-b", cloudB);
  await device.service.syncAll(true);

  assert.deepEqual(
    device.db.getAgentConversations().map((chat) => chat.title),
    ["Missed while the clock was fast"]
  );

  // Each account's corrected cursors survive later switches without replaying.
  await device.signIn("account-a", cloudA);
  const listsBefore = cloudA.logFor("/api/conversations/list").length;
  await device.service.syncAll(true);
  const lists = cloudA.logFor("/api/conversations/list").slice(listsBefore);
  assert.ok(lists.length > 0);
  assert.ok(lists.every((call) => new URL(call.path, "https://x").searchParams.get("since")));
});
