// Conversation half of SyncService: the real service drives the real
// ConversationsService/cloudApi stack over a real DatabaseManager, with only the
// HTTP boundary faked. The pull gate is the target — local rows carry SQLite's
// "YYYY-MM-DD HH:MM:SS" while the cloud answers in ISO, and on the same UTC day
// a raw string compare hands every cloud copy the win.

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

// SQLite's datetime() format, the one local rows actually carry.
const LOCAL_EARLY = "2026-07-20 10:00:00";

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  const api = createElectronApi(db, { cloud });
  windowStub.electronAPI = api;
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, api, service };
}

// Deterministic timestamps come from SQL, never from a fake clock.
function updateConversation(db, id, fields) {
  const keys = Object.keys(fields);
  db.db
    .prepare(
      `UPDATE agent_conversations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`
    )
    .run(...keys.map((k) => fields[k]), id);
  return db.getAgentConversation(id);
}

function messageCount(db) {
  return db.db.prepare("SELECT COUNT(*) AS c FROM agent_messages").get().c;
}

function queryParam(path, name) {
  const [, query] = path.split("?");
  return new URLSearchParams(query ?? "").get(name);
}

function pauseNextConversationCreate(api) {
  const request = api.cloudApiRequest;
  let resume;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const resumed = new Promise((resolve) => {
    resume = resolve;
  });

  api.cloudApiRequest = async (options) => {
    if (options.method === "POST" && options.path === "/api/conversations/create") {
      signalStarted();
      await resumed;
      api.cloudApiRequest = request;
    }
    return request(options);
  };

  return { started, resume };
}

// A first pass before the chat exists leaves the delta cursor in place, so the
// next pull sees tombstones the way an established device does.
async function establishCursor(service) {
  await service.syncAll(true);
  assert.ok(localStorageStub.getItem("lastSyncedAt.conversations"));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function cloudContents(cloud, clientId) {
  return cloud.conversation(clientId).messages.map((message) => message.content);
}

function assertOneLiveCopy(cloud, clientId, contents) {
  const copies = cloud.conversations().filter((c) => c.client_conversation_id === clientId);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].deleted_at, null, "the cloud copy must stay live");
  assert.deepEqual(
    copies[0].messages.map((message) => message.content),
    contents
  );
}

test("a chat edited during its first create survives on an established device", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("In-flight conversation");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  const firstSync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "late message", { toolCalls: [{ id: "t1" }] });
  db.updateAgentConversationTitle(conversation.id, "Renamed in flight");
  gate.resume();
  await firstSync;

  const local = db.getAgentConversation(conversation.id);
  assert.ok(local, "the chat must survive the pass");
  assert.deepEqual(
    local.messages.map((message) => message.content),
    ["first message", "late message"]
  );
  assert.equal(local.title, "Renamed in flight");
  assert.equal(local.sync_status, "synced");
  assert.equal(cloud.logFor("/api/conversations/delete").length, 0);
  assertOneLiveCopy(cloud, clientId, ["first message", "late message"]);
  assert.equal(cloud.conversation(clientId).title, "Renamed in flight");
  assert.deepEqual(cloud.conversation(clientId).messages[1].metadata, {
    toolCalls: [{ id: "t1" }],
  });
  assert.equal(local.cloud_id, cloud.conversation(clientId).id);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/conversations/create").length, 1);
  assert.equal(db.getAgentConversation(conversation.id).messages.length, 2);
  assertOneLiveCopy(cloud, clientId, ["first message", "late message"]);
});

test("a refused follow-up retries with only what the cloud is missing", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Bearer changes in flight");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  // Everything after the create is refused, as with a bearer that expired or
  // changed while the request was out.
  cloud.failWith(
    (call) =>
      call.path.startsWith("/api/conversations/messages") ||
      call.path === "/api/conversations/delete",
    { status: 401 }
  );
  const firstSync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "second message");
  db.addAgentMessage(conversation.id, "user", "third message");
  gate.resume();
  await firstSync;

  const pending = db.getAgentConversation(conversation.id);
  assert.ok(pending, "the chat must survive the refusal");
  assert.equal(pending.sync_status, "pending");
  assert.ok(pending.cloud_id, "the returned copy is linked before anything else can fail");
  assert.equal(cloud.logFor("/api/conversations/delete").length, 0);
  assert.deepEqual(cloudContents(cloud, clientId), ["first message"]);

  cloud.clearFailures();
  // Only the second message lands, so the next pass has to read what is there.
  let posts = 0;
  cloud.failWith(
    (call) => call.method === "POST" && call.path === "/api/conversations/messages" && ++posts > 1,
    { status: 503 }
  );
  await service.syncAll(true);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "pending");
  assert.deepEqual(cloudContents(cloud, clientId), ["first message", "second message"]);
  assert.equal(
    db.getAgentConversation(conversation.id).messages.length,
    3,
    "a partial cloud copy must not replace local history"
  );

  cloud.clearFailures();
  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/conversations/create").length, 1);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
  assert.equal(db.getAgentConversation(conversation.id).messages.length, 3);
  assertOneLiveCopy(cloud, clientId, ["first message", "second message", "third message"]);
});

test("a chat whose copy another account holds waits without touching that copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Account switched in flight");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  // The routes scope every id to the signed-in user, so the next account gets 404s.
  cloud.failWith(
    (call) =>
      call.path.startsWith("/api/conversations/messages") ||
      call.path === "/api/conversations/update" ||
      call.path === "/api/conversations/delete",
    { status: 404 }
  );
  const sync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "second message");
  gate.resume();
  await sync;
  await service.syncAll(true);

  const waiting = db.getAgentConversation(conversation.id);
  assert.equal(waiting.messages.length, 2);
  assert.equal(waiting.sync_status, "pending");
  assert.equal(cloud.logFor("/api/conversations/create").length, 1);
  assert.equal(cloud.logFor("/api/conversations/delete").length, 0);

  // Back on the first account, the same copy gets the rest.
  cloud.clearFailures();
  await service.syncAll(true);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
  assertOneLiveCopy(cloud, clientId, ["first message", "second message"]);
});

test("a create that may already have landed is retried without its messages", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Lost receipt");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  // The server applied the create; only its response was lost.
  db.markConversationCreateAttempted(conversation.id);
  cloud.seedConversation({
    client_conversation_id: clientId,
    title: "Lost receipt",
    messages: [{ role: "user", content: "first message" }],
  });
  db.addAgentMessage(conversation.id, "assistant", "second message");

  await service.syncAll(true);

  assert.deepEqual(cloud.logFor("/api/conversations/create")[0].body.messages, []);
  assertOneLiveCopy(cloud, clientId, ["first message", "second message"]);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
});

test("a message the route can't store never holds up the rest of the chat", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Tool-only turn");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  const sync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "", { toolCalls: [{ id: "t1" }] });
  db.addAgentMessage(conversation.id, "assistant", "answer");
  gate.resume();
  await sync;

  assertOneLiveCopy(cloud, clientId, ["first message", "answer"]);
  const local = db.getAgentConversation(conversation.id);
  assert.equal(local.sync_status, "synced");
  assert.equal(local.messages.length, 3, "the shorter cloud copy must not replace local history");
});

test("an edit during the follow-up keeps the chat pending until the cloud has it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Still typing");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  let edited = false;
  cloud.failWith((call) => {
    if (!edited && call.method === "PATCH" && call.path === "/api/conversations/update") {
      edited = true;
      db.addAgentMessage(conversation.id, "user", "third message");
    }
    return false;
  });
  const sync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "second message");
  gate.resume();
  await sync;

  assert.ok(edited);
  const pending = db.getAgentConversation(conversation.id);
  assert.equal(pending.sync_status, "pending");
  assert.equal(pending.messages.length, 3);

  await service.syncAll(true);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
  assertOneLiveCopy(cloud, clientId, ["first message", "second message", "third message"]);
});

test("a chat deleted during the follow-up is not brought back", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Deleted in flight");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  const sync = service.syncAll(true);
  await gate.started;
  db.deleteAgentConversation(conversation.id);
  gate.resume();
  await sync;

  assert.equal(db.getConversationByClientId(clientId), null);
  assert.ok(cloud.conversation(clientId).deleted_at, "the delete reaches the cloud");
});

test("a create answered with a tombstone starts a new cloud copy instead of linking it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Tombstoned by an older build");
  db.addAgentMessage(conversation.id, "user", "first message");
  const oldClientId = db.getAgentConversation(conversation.id).client_conversation_id;
  db.markConversationCreateAttempted(conversation.id);
  cloud.seedConversation({
    client_conversation_id: oldClientId,
    title: "Tombstoned by an older build",
    messages: [{ role: "user", content: "first message" }],
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await service.syncAll(true);
  const rekeyed = db.getAgentConversation(conversation.id);
  assert.ok(rekeyed, "the local chat outlives the old copy's tombstone");
  assert.equal(rekeyed.cloud_id, null);
  assert.notEqual(rekeyed.client_conversation_id, oldClientId);

  await service.syncAll(true);
  const synced = db.getAgentConversation(conversation.id);
  assert.equal(synced.sync_status, "synced");
  assertOneLiveCopy(cloud, synced.client_conversation_id, ["first message"]);
  assert.ok(cloud.conversation(oldClientId).deleted_at);
});

test("a losing concurrent conversation create is deleted without replacing the winner", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Concurrent conversation");
  db.addAgentMessage(conversation.id, "user", "hello");
  const gate = pauseNextConversationCreate(api);

  const sync = service.syncAll(true);
  await gate.started;
  db.markConversationSynced(conversation.id, "cloud-winner");
  gate.resume();
  await sync;

  const current = db.getAgentConversation(conversation.id);
  assert.ok(current, "the loser's tombstone must not delete the row linked to the winner");
  assert.equal(current.cloud_id, "cloud-winner");
  assert.deepEqual(
    current.messages.map((message) => message.content),
    ["hello"]
  );
  assert.equal(cloud.logFor("/api/conversations/delete").length, 1);
});

test("pullConversations applies a strictly newer cloud copy and rejects older and tied ones", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  // All three cloud copies sit on the same UTC day as the local rows, where a
  // raw string compare wrongly elects the cloud value ('T' > ' ' at index 10).
  const cases = [
    { key: "older", cloudUpdatedAt: "2026-07-20T09:00:00.000Z", applied: false },
    { key: "newer", cloudUpdatedAt: "2026-07-20T11:00:00.000Z", applied: true },
    { key: "tied", cloudUpdatedAt: "2026-07-20T10:00:00.000Z", applied: false },
  ];

  for (const c of cases) {
    const cloudRow = cloud.seedConversation({
      client_conversation_id: `client-${c.key}`,
      title: `Cloud ${c.key}`,
      created_at: "2026-07-20T08:00:00.000Z",
      updated_at: c.cloudUpdatedAt,
      messages: [
        { role: "user", content: `cloud message ${c.key}`, created_at: "2026-07-20T08:30:00.000Z" },
      ],
    });
    const local = db.createAgentConversation(`Local ${c.key}`);
    db.addAgentMessage(local.id, "user", `local message ${c.key}`);
    // Set updated_at last: addAgentMessage bumps it to CURRENT_TIMESTAMP.
    updateConversation(db, local.id, {
      client_conversation_id: cloudRow.client_conversation_id,
      cloud_id: cloudRow.id,
      sync_status: "synced",
      created_at: LOCAL_EARLY,
      updated_at: LOCAL_EARLY,
    });
    c.localId = local.id;
  }

  await service.syncAll(true);

  const listCalls = cloud.logFor("/api/conversations/list");
  assert.equal(listCalls.length, 1, "three cloud rows must take exactly one page");
  assert.equal(queryParam(listCalls[0].path, "include"), "messages");
  assert.equal(queryParam(listCalls[0].path, "since"), null, "a fresh pull carries no cursor");
  assert.equal(
    cloud.logFor("/api/conversations/create").length,
    0,
    "the local rows are already synced, so nothing may be pushed ahead of the pull"
  );

  for (const c of cases) {
    const row = db.getAgentConversation(c.localId);
    const contents = row.messages.map((m) => m.content);
    if (c.applied) {
      assert.equal(row.title, `Cloud ${c.key}`, "a strictly newer cloud copy must win");
      assert.deepEqual(contents, [`cloud message ${c.key}`]);
      assert.equal(row.sync_status, "synced");
    } else {
      assert.equal(
        row.title,
        `Local ${c.key}`,
        `the ${c.key} cloud copy must not overwrite the local row`
      );
      assert.equal(row.updated_at, LOCAL_EARLY, "a rejected pull must not move updated_at");
      assert.deepEqual(
        contents,
        [`local message ${c.key}`],
        `the ${c.key} cloud copy must not replace the local messages`
      );
    }
  }
});

test("a cloud conversation tombstone hard-deletes the local row and its messages", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;

  const cloudRow = cloud.seedConversation({
    client_conversation_id: "client-tombstoned",
    title: "Deleted elsewhere",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
    deleted_at: "2026-07-20T12:00:00.000Z",
  });
  const local = db.createAgentConversation("Deleted elsewhere");
  db.addAgentMessage(local.id, "user", "gone");
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  // Tombstones only travel on the delta page, so the cursor must already exist.
  localStorageStub.setItem("lastSyncedAt.conversations", "2026-07-01T00:00:00.000Z");
  await service.syncAll(true);

  const listCalls = cloud.logFor("/api/conversations/list");
  assert.equal(
    queryParam(listCalls[0].path, "since"),
    "2026-07-01T00:00:00.000Z",
    "the delta page must be requested with the stored cursor"
  );
  assert.equal(
    db.getConversationByClientId("client-tombstoned"),
    null,
    "the local row must be removed"
  );
  assert.equal(messageCount(db), 0, "the messages go with the conversation");
});

test("a tombstone leaves a live chat that was never linked to that copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const local = db.createAgentConversation("Never linked");
  db.addAgentMessage(local.id, "user", "keep me");
  const clientId = db.getAgentConversation(local.id).client_conversation_id;
  cloud.seedConversation({
    client_conversation_id: clientId,
    title: "Never linked",
    deleted_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
  });
  // The create fails, so the pull reaches the tombstone while the row is unlinked.
  cloud.failNext((call) => call.path === "/api/conversations/create", { status: 503 });
  localStorageStub.setItem("lastSyncedAt.conversations", "2026-07-01T00:00:00.000Z");

  await service.syncAll(true);

  assert.equal(db.getAgentConversation(local.id).messages.length, 1);
});

test("a tombstone clears a locally deleted chat whose create receipt never arrived", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const local = db.createAgentConversation("Deleted here, then there");
  const clientId = db.getAgentConversation(local.id).client_conversation_id;
  db.markConversationCreateAttempted(local.id);
  db.deleteAgentConversation(local.id);
  cloud.seedConversation({
    client_conversation_id: clientId,
    deleted_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
  });
  localStorageStub.setItem("lastSyncedAt.conversations", "2026-07-01T00:00:00.000Z");

  await service.syncAll(true);

  assert.equal(db.getConversationByClientId(clientId), null);
});

test("a pull never replaces a chat with a shorter cloud copy", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const cloudRow = cloud.seedConversation({
    client_conversation_id: "client-shorter",
    title: "Cloud title",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
    messages: [{ role: "user", content: "first message" }],
  });
  const local = db.createAgentConversation("Local title");
  db.addAgentMessage(local.id, "user", "first message");
  db.addAgentMessage(local.id, "assistant", "only on this device");
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "synced",
    created_at: LOCAL_EARLY,
    updated_at: LOCAL_EARLY,
  });

  await service.syncAll(true);

  assert.equal(db.getAgentConversation(local.id).messages.length, 2);
});

for (const cloudMessageCount of [1, 3]) {
  test(`a message saved after the pull lookup survives a ${cloudMessageCount}-message cloud copy`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const cloudRow = cloud.seedConversation({
      client_conversation_id: `client-pull-race-${cloudMessageCount}`,
      title: "Cloud title",
      created_at: "2026-07-20T08:00:00.000Z",
      updated_at: "2026-07-20T12:00:00.000Z",
      messages: [
        { role: "user", content: "first message" },
        ...Array.from({ length: cloudMessageCount - 1 }, (_, index) => ({
          role: "assistant",
          content: `cloud message ${index + 1}`,
        })),
      ],
    });
    const local = db.createAgentConversation("Local title");
    db.addAgentMessage(local.id, "user", "first message");
    updateConversation(db, local.id, {
      client_conversation_id: cloudRow.client_conversation_id,
      cloud_id: cloudRow.id,
      sync_status: "synced",
      updated_at: LOCAL_EARLY,
    });

    const upsert = api.upsertConversationFromCloud;
    let savedDuringPull;
    api.upsertConversationFromCloud = async (...args) => {
      db.addAgentMessage(local.id, "assistant", "saved during sync", {
        toolCalls: [{ id: "saved-tool-call" }],
      });
      // Same-second writes cannot rely on updated_at changing to detect the race.
      updateConversation(db, local.id, { updated_at: LOCAL_EARLY });
      savedDuringPull = db.getAgentConversation(local.id);
      api.upsertConversationFromCloud = upsert;
      return upsert(...args);
    };

    await service.syncAll(true);

    assert.ok(savedDuringPull, "the message is saved after the renderer's pull check");
    assert.deepEqual(db.getAgentConversation(local.id), savedDuringPull);
  });
}

test("a pull leaves a linked chat alone until its unsent edit is pushed", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const cloudRow = cloud.seedConversation({
    client_conversation_id: "client-unsent",
    title: "Old title",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T12:00:00.000Z",
    messages: [{ role: "user", content: "first message" }],
  });
  const local = db.createAgentConversation("New title");
  db.addAgentMessage(local.id, "user", "first message");
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
    updated_at: LOCAL_EARLY,
  });
  cloud.failNext((call) => call.path === "/api/conversations/update", { status: 503 });

  await service.syncAll(true);

  const row = db.getAgentConversation(local.id);
  assert.equal(row.title, "New title");
  assert.equal(row.sync_status, "pending");

  await service.syncAll(true);
  assert.equal(cloud.conversation("client-unsent").title, "New title");
  assert.equal(db.getAgentConversation(local.id).sync_status, "synced");
});

test("a chat already linked and still pending gets what the cloud is missing", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const cloudRow = cloud.seedConversation({
    client_conversation_id: "client-linked",
    title: "Old title",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T09:00:00.000Z",
    messages: [{ role: "user", content: "same text" }],
  });
  const local = db.createAgentConversation("New title");
  db.addAgentMessage(local.id, "user", "same text");
  db.addAgentMessage(local.id, "user", "same text");
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
  });

  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/conversations/create").length, 0);
  assertOneLiveCopy(cloud, "client-linked", ["same text", "same text"]);
  assert.equal(cloud.conversation("client-linked").title, "New title");
  assert.equal(db.getAgentConversation(local.id).sync_status, "synced");
});
