// Conversation half of SyncService: the real service drives the real
// ConversationsService/cloudApi stack over a real DatabaseManager, with only the
// HTTP boundary faked. Covers the push, its follow-up and the pull gate, where
// local rows carry SQLite's "YYYY-MM-DD HH:MM:SS" while the cloud answers in ISO,
// and on the same UTC day a raw string compare hands every cloud copy the win.

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
  // As useAuth leaves it: main scoped to the account the renderer signed in as.
  db.setActiveAccountId("user-harness");
  await establishValidatedAuth("user-harness");
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

test("a reply regenerated while its chat uploads goes up once and stays new here", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Regenerated reply");
  db.addAgentMessage(conversation.id, "user", "question");
  const reply = db.addAgentMessage(conversation.id, "assistant", "first answer");
  // Older, so the regenerate below changes the chat's time within this second.
  updateConversation(db, conversation.id, { updated_at: LOCAL_EARLY });
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  const sync = service.syncAll(true);
  await gate.started;
  db.updateAgentMessage(reply.id, "second answer", null);
  gate.resume();
  await sync;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.syncAll(true);

  // The cloud can't change a message, so its copy keeps the first answer.
  assertOneLiveCopy(cloud, clientId, ["question", "first answer"]);
  const local = db.getAgentConversation(conversation.id);
  assert.deepEqual(
    local.messages.map((message) => message.content),
    ["question", "second answer"]
  );
  assert.equal(local.sync_status, "synced");
});

test("a reply regenerated with no text keeps its place, so the next turn goes up once", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Card-only reply");
  db.addAgentMessage(conversation.id, "user", "question");
  const reply = db.addAgentMessage(conversation.id, "assistant", "Done.");
  updateConversation(db, conversation.id, { updated_at: LOCAL_EARLY });
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  // The first follow-up can't settle, so a second one reads what it sent.
  cloud.failWith("/api/conversations/update", { status: 500 });
  const sync = service.syncAll(true);
  await gate.started;
  db.updateAgentMessage(reply.id, "", { toolCalls: [{ id: "t1" }] });
  db.addAgentMessage(conversation.id, "user", "follow-up");
  // The same words as the reply the cloud holds, so only its place tells them apart.
  db.addAgentMessage(conversation.id, "assistant", "Done.");
  gate.resume();
  await sync;
  cloud.clearFailures();
  await service.syncAll(true);

  assertOneLiveCopy(cloud, clientId, ["question", "Done.", "follow-up", "Done."]);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
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

test("a chat deleted during its create is not brought back", async (t) => {
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

test("a chat deleted during the follow-up is not brought back", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Deleted in the follow-up");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  let deleted = false;
  cloud.failWith((call) => {
    if (!deleted && call.method === "PATCH" && call.path === "/api/conversations/update") {
      deleted = true;
      db.deleteAgentConversation(conversation.id);
    }
    return false;
  });
  const sync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "second message");
  gate.resume();
  await sync;

  assert.ok(deleted);
  assert.equal(db.getConversationByClientId(clientId), null);
  assert.ok(cloud.conversation(clientId).deleted_at, "the delete reaches the cloud");
});

test("a title update that keeps failing leaves the messages sent and the chat pending", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  await establishCursor(service);
  const conversation = db.createAgentConversation("Old title");
  db.addAgentMessage(conversation.id, "user", "first message");
  const clientId = db.getAgentConversation(conversation.id).client_conversation_id;
  const gate = pauseNextConversationCreate(api);

  cloud.failWith("/api/conversations/update", { status: 500 });
  const sync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "second message");
  db.updateAgentConversationTitle(conversation.id, "New title");
  gate.resume();
  await sync;
  await service.syncAll(true);
  await service.syncAll(true);

  const pending = db.getAgentConversation(conversation.id);
  assert.equal(pending.sync_status, "pending");
  assert.equal(pending.title, "New title", "the pull must skip a chat still pending");
  assert.equal(pending.messages.length, 2);
  assert.equal(cloud.logFor("/api/conversations/create").length, 1);
  assertOneLiveCopy(cloud, clientId, ["first message", "second message"]);
  assert.equal(cloud.conversation(clientId).title, "Old title");

  cloud.clearFailures();
  await service.syncAll(true);
  assert.equal(db.getAgentConversation(conversation.id).sync_status, "synced");
  assert.equal(cloud.conversation(clientId).title, "New title");
  assertOneLiveCopy(cloud, clientId, ["first message", "second message"]);
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
  assert.equal(cloud.logFor("/api/conversations/create").at(-1).body.messages.length, 1);
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

test("a conversation isn't pushed while a reply waits on the user, only once its turn ends", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const conversation = db.createAgentConversation("Waiting on a question");
  db.addAgentMessage(conversation.id, "user", "Post the update");
  const reply = db.addAgentMessage(conversation.id, "assistant", "", {
    turn: { startedAt: Date.now(), status: "waiting" },
  });
  // A turn that old was cut off (the app quit); it goes as it is.
  const cutOff = db.createAgentConversation("Cut off");
  db.addAgentMessage(cutOff.id, "assistant", "", {
    turn: { startedAt: Date.now() - 2 * 60 * 60 * 1000, status: "running" },
  });

  await service.syncAll(true);
  assert.deepEqual(
    cloud.logFor("/api/conversations/create").map((entry) => entry.body.title),
    ["Cut off"]
  );

  db.updateAgentMessage(reply.id, "Posted.", {
    turn: { startedAt: Date.now(), finishedAt: Date.now(), status: "complete" },
  });
  await service.syncAll(true);
  const pushed = cloud.logFor("/api/conversations/create").at(-1).body;
  assert.equal(pushed.title, "Waiting on a question");
  assert.deepEqual(
    pushed.messages.map((message) => message.content),
    ["Post the update", "Posted."]
  );
});

function seedForkedChat(db) {
  const parent = db.createAgentConversation("Plan the launch");
  const rows = [
    db.addAgentMessage(parent.id, "user", "Draft the launch email"),
    db.addAgentMessage(parent.id, "assistant", "Here is a draft."),
    db.addAgentMessage(parent.id, "user", "Make it shorter"),
  ];
  const fork = db.forkAgentConversation(parent.id, rows[1].id, "Here is a draft.");
  return { parent: db.getAgentConversation(parent.id), fork };
}

test("a fork waits for its first turn, so another device gets what it says and its title", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const { fork } = seedForkedChat(db);
  const pushedFork = () =>
    cloud
      .logFor("/api/conversations/create")
      .map((entry) => entry.body)
      .find((body) => body.client_conversation_id === fork.client_conversation_id);

  await service.pushPendingConversations();
  assert.equal(pushedFork(), undefined, "a fork of only copies stays here");

  db.updateAgentConversationTitle(fork.id, "My own branch");
  db.addAgentMessage(fork.id, "user", "Only in the fork");
  db.addAgentMessage(fork.id, "assistant", "Fork reply");
  await service.pushPendingConversations();

  const pushed = pushedFork();
  assert.equal(pushed.title, "My own branch");
  assert.equal(pushed.fork_message_count, 2);
  assert.equal(pushed.messages.at(-1).content, "Fork reply");
});

test("a fork is pushed with its parent's client id, its copied count and its text", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const { parent, fork } = seedForkedChat(db);
  db.addAgentMessage(fork.id, "user", "Only in the fork");
  db.addAgentMessage(fork.id, "assistant", "Fork reply");

  await service.syncAll(true);

  const bodies = new Map(
    cloud
      .logFor("/api/conversations/create")
      .map((entry) => [entry.body.client_conversation_id, entry.body])
  );
  const pushedFork = bodies.get(fork.client_conversation_id);
  assert.equal(pushedFork.parent_client_conversation_id, parent.client_conversation_id);
  assert.equal(pushedFork.fork_message_count, 2);
  assert.equal(pushedFork.fork_context, "Here is a draft.");
  assert.equal(pushedFork.messages.length, 4);
  const pushedParent = bodies.get(parent.client_conversation_id);
  assert.equal(pushedParent.parent_client_conversation_id, null);
  assert.equal(pushedParent.fork_message_count, null);
  assert.equal(pushedParent.fork_context, null);
});

test("a fork created on a retry counts only the copied messages its cloud copy gets", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const parent = db.createAgentConversation("Email the notes");
  db.addAgentMessage(parent.id, "user", "Email Sam the notes");
  // A card-only turn saves an empty reply, which the messages route refuses.
  const cardOnly = db.addAgentMessage(parent.id, "assistant", "", {
    turn: { startedAt: 1, finishedAt: 2, status: "complete" },
  });
  const fork = db.forkAgentConversation(parent.id, cardOnly.id, null);
  db.addAgentMessage(fork.id, "user", "Now draft one for Ana");
  db.addAgentMessage(fork.id, "assistant", "Here is Ana's draft.");
  // An earlier create went out and failed, so this one carries no messages.
  updateConversation(db, fork.id, { cloud_create_attempted: 1 });

  await service.pushPendingConversations();

  const copy = cloud.conversation(fork.client_conversation_id);
  assert.equal(copy.fork_message_count, 1);
  assert.deepEqual(
    copy.messages.slice(copy.fork_message_count).map((message) => message.content),
    ["Now draft one for Ana", "Here is Ana's draft."],
    "another device shows the fork's own turns"
  );
});

const CLOUD_PARENT = {
  client_conversation_id: "cloud-parent",
  title: "Plan the launch",
  created_at: "2026-07-20T08:00:00.000Z",
  messages: [
    { role: "user", content: "Draft the launch email" },
    { role: "assistant", content: "Here is a draft." },
  ],
};

function cloudFork(clientId, parentClientId, createdAt = "2026-07-20T09:00:00.000Z") {
  return {
    client_conversation_id: clientId,
    title: "Plan the launch",
    created_at: createdAt,
    messages: [...CLOUD_PARENT.messages, { role: "user", content: "Only in the fork" }],
    parent_client_conversation_id: parentClientId,
    fork_message_count: 2,
    fork_context: "Here is a draft.",
  };
}

test("another device links a pulled fork to its parent, which the list sends after it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  cloud.seedConversation(CLOUD_PARENT);
  cloud.seedConversation(cloudFork("cloud-fork", "cloud-parent"));

  await service.syncAll(true);

  const [listed] = cloud.logFor("/api/conversations/list");
  assert.equal(queryParam(listed.path, "since"), null, "a fresh device lists newest first");
  const parent = db.getConversationByClientId("cloud-parent");
  const fork = db.getAgentConversation(db.getConversationByClientId("cloud-fork").id);
  assert.equal(fork.parent_conversation_id, parent.id);
  assert.equal(fork.parent_title, "Plan the launch");
  assert.equal(fork.fork_message_count, 2);
  assert.equal(fork.fork_context, "Here is a draft.");
  assert.equal(db.getAgentConversation(parent.id).parent_conversation_id, null);
});

test("a fork links once a later sync brings its parent; a deleted parent leaves a plain chat", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  cloud.seedConversation({
    client_conversation_id: "deleted-parent",
    created_at: "2026-07-20T07:00:00.000Z",
    deleted_at: "2026-07-20T07:30:00.000Z",
  });
  cloud.seedConversation(cloudFork("fork-of-deleted", "deleted-parent"));
  cloud.seedConversation(cloudFork("fork-waiting", "cloud-parent"));

  await service.syncAll(true);

  const waiting = db.getConversationByClientId("fork-waiting");
  assert.equal(waiting.parent_conversation_id, null, "no parent on this device yet");
  assert.equal(db.getAgentConversation(waiting.id).messages.length, 3);

  cloud.seedConversation({ ...CLOUD_PARENT, updated_at: "2099-01-01T00:00:00.000Z" });
  await service.syncAll(true);

  const parent = db.getConversationByClientId("cloud-parent");
  assert.ok(parent, "the parent arrived on the delta page");
  assert.equal(db.getConversationByClientId("fork-waiting").parent_conversation_id, parent.id);
  assert.equal(db.getConversationByClientId("fork-of-deleted").parent_conversation_id, null);
});

test("chats from an API without fork fields arrive plain, and a local fork keeps its origin", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const { parent, fork } = seedForkedChat(db);
  // The fork went to an API that dropped its origin, then was renamed elsewhere.
  const cloudCopy = cloud.seedConversation({
    client_conversation_id: fork.client_conversation_id,
    title: "Renamed elsewhere",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "Draft the launch email" },
      { role: "assistant", content: "Here is a draft." },
    ],
  });
  assert.equal("parent_client_conversation_id" in cloudCopy, false);
  updateConversation(db, fork.id, {
    cloud_id: cloudCopy.id,
    sync_status: "synced",
    updated_at: LOCAL_EARLY,
  });
  cloud.seedConversation({ client_conversation_id: "plain-elsewhere", title: "Plain" });

  await service.syncAll(true);

  const pulled = db.getAgentConversation(fork.id);
  assert.equal(pulled.title, "Renamed elsewhere");
  assert.equal(pulled.parent_conversation_id, parent.id);
  assert.equal(pulled.fork_message_count, 2);
  assert.equal(pulled.fork_context, "Here is a draft.");
  assert.equal(db.getConversationByClientId("plain-elsewhere").parent_conversation_id, null);
});

test("both conversation upload paths omit reasoning while retaining local turn and selected context metadata", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  for (const method of ["pushConversation", "pushPendingConversations"]) {
    const conversation = db.createAgentConversation(method);
    const selected = { selectedContext: "Selected text", selectedContextSource: "external" };
    db.addAgentMessage(conversation.id, "user", "Explain this", selected);
    const metadata = {
      turn: {
        status: "complete",
        startedAt: 1,
        finishedAt: 2,
        reasoning: "Private connector fact",
      },
      toolCalls: [{ id: "lookup", name: "find_contact", status: "completed" }],
    };
    const reply = db.addAgentMessage(conversation.id, "assistant", "Public answer", metadata);
    await service[method](conversation.id);
    const uploaded = cloud.logFor("/api/conversations/create").at(-1).body;
    assert.deepEqual(uploaded.messages[0].metadata, selected);
    assert.deepEqual(uploaded.messages[1].metadata, {
      ...metadata,
      turn: { status: "complete", startedAt: 1, finishedAt: 2 },
    });
    assert.deepEqual(
      JSON.parse(
        db.getAgentConversation(conversation.id).messages.find((row) => row.id === reply.id)
          .metadata
      ),
      metadata
    );
  }
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
    messages: [
      { role: "user", content: "same text" },
      { role: "assistant", content: "other role" },
    ],
  });
  const local = db.createAgentConversation("New title");
  db.addAgentMessage(local.id, "user", "same text");
  db.addAgentMessage(local.id, "user", "same text");
  db.addAgentMessage(local.id, "user", "other role");
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
  });

  await service.syncAll(true);

  assert.equal(cloud.logFor("/api/conversations/create").length, 0);
  assertOneLiveCopy(cloud, "client-linked", ["same text", "other role", "same text", "other role"]);
  assert.equal(cloud.conversation("client-linked").title, "New title");
  assert.equal(db.getAgentConversation(local.id).sync_status, "synced");
});

test("a linked chat gets no half turn: a reply waiting on the user goes once it ends", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const cloudRow = cloud.seedConversation({
    client_conversation_id: "client-waiting",
    title: "Post the update",
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-07-20T09:00:00.000Z",
    messages: [{ role: "user", content: "Post the update" }],
  });
  const local = db.createAgentConversation("Post the update");
  db.addAgentMessage(local.id, "user", "Post the update");
  const reply = db.addAgentMessage(local.id, "assistant", "Which channel?", {
    turn: { startedAt: Date.now(), status: "waiting" },
  });
  updateConversation(db, local.id, {
    client_conversation_id: cloudRow.client_conversation_id,
    cloud_id: cloudRow.id,
    sync_status: "pending",
  });

  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/conversations/messages").length, 0, "nothing sent mid-turn");
  assert.equal(db.getAgentConversation(local.id).sync_status, "pending");

  db.updateAgentMessage(reply.id, "Posted in #eng.", {
    turn: { startedAt: Date.now(), finishedAt: Date.now(), status: "complete" },
  });
  await service.syncAll(true);
  assertOneLiveCopy(cloud, "client-waiting", ["Post the update", "Posted in #eng."]);
  assert.equal(db.getAgentConversation(local.id).sync_status, "synced");
});

test("a chat linked to another copy, or deleted, keeps its identity", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;
  const linked = db.createAgentConversation("Linked");
  const clientId = db.getAgentConversation(linked.id).client_conversation_id;
  const row = updateConversation(db, linked.id, {
    cloud_id: "cloud-winner",
    sync_status: "pending",
  });
  const snapshot = { title: row.title, updated_at: row.updated_at, message_count: 0 };

  assert.equal(db.markConversationSynced(linked.id, "cloud-loser", snapshot).success, false);
  assert.equal(db.getAgentConversation(linked.id).sync_status, "pending");
  assert.equal(db.replaceConversationClientId(linked.id, clientId).success, false);
  assert.equal(db.getAgentConversation(linked.id).client_conversation_id, clientId);

  const deleted = db.createAgentConversation("Deleted");
  const deletedClientId = db.getAgentConversation(deleted.id).client_conversation_id;
  db.markConversationCreateAttempted(deleted.id);
  db.deleteAgentConversation(deleted.id);
  assert.equal(db.replaceConversationClientId(deleted.id, deletedClientId).success, false);
  assert.ok(db.getConversationByClientId(deletedClientId));
});

test("a pull lookup gone stale never replaces the chat", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;
  const local = db.createAgentConversation("Local title");
  db.addAgentMessage(local.id, "user", "local message");
  const clientId = db.getAgentConversation(local.id).client_conversation_id;
  const cloudCopy = {
    id: "cloud-copy",
    client_conversation_id: clientId,
    title: "Cloud title",
    updated_at: "2026-07-20T12:00:00.000Z",
  };
  const snapshot = db.getConversationByClientId(clientId);

  // The lookup found no chat, and one exists now.
  db.upsertConversationFromCloud(cloudCopy, [], null);
  // Title, updated_at and message count still match; only the link moved.
  updateConversation(db, local.id, { cloud_id: "another-copy" });
  db.upsertConversationFromCloud(cloudCopy, [], snapshot);

  const row = db.getAgentConversation(local.id);
  assert.equal(row.title, "Local title");
  assert.equal(row.messages.length, 1);
});

test("a pulled chat keeps its message and list order beside local timestamps", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  cloud.seedConversation({
    client_conversation_id: "client-pulled",
    title: "Pulled",
    updated_at: "2026-07-20T09:00:00.000Z",
    messages: [
      { role: "user", content: "q1", created_at: "2026-07-20T09:00:00.000Z" },
      { role: "assistant", content: "a1", created_at: "2026-07-20T09:00:01.000Z" },
    ],
  });
  await service.syncAll(true);
  const pulled = db.getConversationByClientId("client-pulled");

  // Same UTC day in SQLite's format, which as a raw string sorts before the ISO rows.
  const next = db.addAgentMessage(pulled.id, "user", "q2");
  db.db.prepare("UPDATE agent_messages SET created_at = ? WHERE id = ?").run(LOCAL_EARLY, next.id);
  const local = db.createAgentConversation("Local");
  updateConversation(db, pulled.id, { updated_at: "2026-07-20T09:00:00.000Z" });
  updateConversation(db, local.id, { updated_at: LOCAL_EARLY });

  const contents = (messages) => messages.map((message) => message.content);
  assert.deepEqual(contents(db.getAgentConversation(pulled.id).messages), ["q1", "a1", "q2"]);
  assert.deepEqual(contents(db.getAgentMessages(pulled.id)), ["q1", "a1", "q2"]);

  const list = db.getAgentConversationsWithPreview();
  assert.deepEqual(
    list.map((conversation) => conversation.title),
    ["Local", "Pulled"]
  );
  for (const row of [list[1], db.searchAgentConversations("Pulled")[0]]) {
    assert.equal(row.last_message, "q2");
    assert.equal(row.last_message_role, "user");
  }
});

for (const pauseAt of ["earlier root chat", "note chat create", "message lookup"]) {
  test(`a note moved to Private stops chat uploads during ${pauseAt}`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const { joinTeamSpace } = require("./harness/teamSpace.js");
    const team = joinTeamSpace(db, cloud);
    const root = db.createAgentConversation("Root first");
    db.addAgentMessage(root.id, "user", "root message");
    const note = db.saveNote("Team", "draft", "personal", null, null, null, team.id).note;
    const chat = db.createAgentConversation("Note chat", note.id);
    db.addAgentMessage(chat.id, "user", "team message");
    if (pauseAt === "message lookup") {
      const copy = cloud.seedConversation({
        client_conversation_id: chat.client_conversation_id,
        messages: [{ role: "user", content: "team message" }],
      });
      updateConversation(db, chat.id, { cloud_id: copy.id, sync_status: "synced" });
    }
    db.addAgentMessage(chat.id, "user", "pending team message");
    updateConversation(db, chat.id, { sync_status: "pending" });
    const request = api.cloudApiRequest;
    let resume;
    let started;
    const gate = new Promise((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    api.cloudApiRequest = async (options) => {
      const isCreate =
        options.path === "/api/conversations/create" &&
        options.body.client_conversation_id ===
          (pauseAt === "earlier root chat" ? root : chat).client_conversation_id;
      if (
        (pauseAt === "message lookup" &&
          options.method === "GET" &&
          options.path.startsWith("/api/conversations/messages")) ||
        (pauseAt !== "message lookup" && isCreate)
      ) {
        started();
        await gate;
      }
      return request(options);
    };
    const syncing = service.syncAll(true);
    await waiting;
    assert.equal(db.updateNote(note.id, { content: "edited locally" }).success, true);
    assert.equal(db.purgeSpace(team.id).success, true);
    assert.equal(db.getSpace(db.getNote(note.id).space_id).kind, "private");
    db.addAgentMessage(chat.id, "user", "PRIVATE AFTER MOVE");
    resume();
    await syncing;
    const uploaded = cloud.conversation(chat.client_conversation_id);
    assert.equal(
      uploaded?.messages.some((message) => message.content === "PRIVATE AFTER MOVE") ?? false,
      false
    );
    if (pauseAt === "earlier root chat") {
      assert.equal(uploaded, null);
      assert.equal(db.getAgentConversation(chat.id).cloud_create_attempted, 0);
    }
    if (pauseAt === "message lookup")
      assert.deepEqual(cloudContents(cloud, chat.client_conversation_id), ["team message"]);
    assert.deepEqual(cloudContents(cloud, root.client_conversation_id), ["root message"]);
  });
}

test("conversation lists and keywords scope before their result limit", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db } = ctx;
  db.setActiveWorkspaceScope({ activeWorkspaceId: "a", defaultWorkspaceId: "a" });
  const privateA = db.getPrivateSpaceId("a");
  const privateB = db.getPrivateSpaceId("b");
  const noteA = db.saveNote("A", "", "personal", null, null, null, privateA).note;
  const noteB = db.saveNote("B", "", "personal", null, null, null, privateB).note;
  const own = db.createAgentConversation("Match A", noteA.id);
  updateConversation(db, own.id, { updated_at: LOCAL_EARLY });
  for (let index = 0; index < 201; index++) db.createAgentConversation("Match B", noteB.id);
  assert.deepEqual(
    db.getAgentConversationsWithPreview(200, 0, false, [privateA]).map((row) => row.id),
    [own.id]
  );
  assert.deepEqual(
    db.searchAgentConversations("Match", 20, [privateA]).map((row) => row.id),
    [own.id]
  );
  const root = db.createAgentConversation("Match root");
  assert.deepEqual(
    db.searchAgentConversations("Match", 20, []).map((row) => row.id),
    [root.id]
  );
});

for (const tombstone of [false, true]) {
  test(`private note history ignores remote ${tombstone ? "tombstone" : "live row"}`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, service } = ctx;
    const note = db.saveNote("Private", "", "personal").note;
    const chat = db.createAgentConversation("Private chat", note.id);
    db.addAgentMessage(chat.id, "user", "private history");
    const remote = cloud.seedConversation({
      client_conversation_id: chat.client_conversation_id,
      title: "remote replacement",
      updated_at: "2026-07-20T12:00:00.000Z",
      deleted_at: tombstone ? "2026-07-20T12:00:00.000Z" : null,
      messages: [{ role: "user", content: "remote history" }],
    });
    updateConversation(db, chat.id, {
      cloud_id: remote.id,
      sync_status: "synced",
      updated_at: LOCAL_EARLY,
    });
    localStorageStub.setItem("lastSyncedAt.conversations", "2026-07-01T00:00:00.000Z");
    await service.syncAll(true);
    assert.deepEqual(
      db.getAgentConversation(chat.id)?.messages.map((row) => row.content),
      ["private history"]
    );
  });
}

test("get_note marks a root chat before private tool metadata is saved or backed up", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const { createGetNoteTool } = require("../../src/services/tools/getNoteTool.ts");
  const { replyMetadata, saveReplyRow } = require("../../src/components/chat/chatPersistence.ts");
  const note = db.saveNote("Private canary", "PRIVATE_CANARY_3167", "personal").note;
  const chat = db.createAgentConversation("Root chat");
  const result = await createGetNoteTool({
    spaceIds: [note.space_id],
    protectNotes: async (notes) => {
      const protectedChat = await api.protectConversation(chat.id, notes, false, "user-harness");
      assert.equal(protectedChat.success, true);
    },
  }).execute({ id: note.id });
  assert.equal(result.success, true);
  assert.equal(db.getAgentConversation(chat.id).device_only, 1);
  const metadata = replyMetadata([
    {
      id: "private-call",
      name: "get_note",
      arguments: JSON.stringify({ id: note.id }),
      status: "completed",
      result: result.displayText,
      metadata: result.data,
    },
  ]);
  api.addAgentMessage = async (...args) => db.addAgentMessage(...args);
  await saveReplyRow(chat.id, null, "PRIVATE_CANARY_3167", metadata);
  await service.syncAll(true);
  db.addAgentMessage(chat.id, "user", "An unrelated later turn");
  await service.pushConversation(chat.id);
  await service.syncAll(true);
  assert.equal(cloud.conversation(chat.client_conversation_id), null);
  assert.equal(
    JSON.stringify(cloud.logFor("/api/conversations/create")).includes("PRIVATE_CANARY_3167"),
    false
  );
});

for (const pauseAt of ["create acknowledgement", "message lookup", "queued upload"]) {
  test(`root privacy stops pending content during ${pauseAt}`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    const { db, cloud, api, service } = ctx;
    const chat = db.createAgentConversation("Initially ordinary root");
    db.addAgentMessage(chat.id, "user", "Before private content");
    if (pauseAt === "message lookup") {
      await service.pushConversation(chat.id);
      db.addAgentMessage(chat.id, "user", "Another ordinary turn");
      updateConversation(db, chat.id, { sync_status: "pending" });
    }
    const note = db.saveNote("Private", "PRIVATE_RACE_CANARY", "personal").note;
    let resume;
    let start;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    if (pauseAt === "queued upload") {
      const read = api.getAgentConversation;
      let first = true;
      api.getAgentConversation = async (id) => {
        const row = await read(id);
        if (first && id === chat.id) {
          first = false;
          start();
          await paused;
        }
        return row;
      };
    } else {
      const request = api.cloudApiRequest;
      api.cloudApiRequest = async (options) => {
        const matches =
          pauseAt === "create acknowledgement"
            ? options.path === "/api/conversations/create"
            : options.method === "GET" && options.path.startsWith("/api/conversations/messages");
        if (matches) {
          start();
          await paused;
        }
        return request(options);
      };
    }
    const syncing =
      pauseAt === "queued upload"
        ? service.pushConversation(chat.id)
        : service.pushPendingConversations();
    await started;
    assert.equal(db.protectConversation(chat.id, [note], false, "user-harness").success, true);
    db.addAgentMessage(chat.id, "assistant", "PRIVATE_RACE_CANARY");
    resume();
    await syncing;
    await service.syncAll(true);
    const local = db.getAgentConversation(chat.id);
    assert.equal(local.device_only, 1);
    assert.equal(local.messages.at(-1).content, "PRIVATE_RACE_CANARY");
    assert.equal(
      JSON.stringify(cloud.conversation(chat.client_conversation_id)).includes(
        "PRIVATE_RACE_CANARY"
      ),
      false
    );
    assert.equal(cloud.logFor("/api/conversations/delete").length, 0);
    if (pauseAt === "queued upload")
      assert.equal(cloud.conversation(chat.client_conversation_id), null);
    else
      assert.deepEqual(cloudContents(cloud, chat.client_conversation_id), [
        "Before private content",
      ]);
  });
}

test("explicit deletion of a private conversation still deletes its old backup", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const chat = db.createAgentConversation("Ordinary root");
  db.addAgentMessage(chat.id, "user", "Already backed up");
  await service.pushConversation(chat.id);
  const note = db.saveNote("Private", "secret", "personal").note;
  db.protectConversation(chat.id, [note], false, "user-harness");
  db.addAgentMessage(chat.id, "assistant", "Private follow-up");
  assert.equal(db.deleteAgentConversation(chat.id).success, true);
  await service.syncAll(true);
  assert.equal(db.getAgentConversation(chat.id), null);
  assert.equal(cloud.logFor("/api/conversations/delete").length, 1);
  assert.equal(
    JSON.stringify(cloud.logFor("/api/conversations/delete")).includes("Private follow-up"),
    false
  );
});

test("marking after a cloud pull lookup fences both live rows and tombstones in main", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  for (const tombstone of [false, true]) {
    const chat = db.createAgentConversation("Root");
    db.addAgentMessage(chat.id, "user", "Keep local history");
    const remote = cloud.seedConversation({
      client_conversation_id: chat.client_conversation_id,
      title: "Remote",
      updated_at: "2099-01-01T00:00:00.000Z",
      deleted_at: tombstone ? "2099-01-01T00:00:00.000Z" : null,
      messages: [{ role: "user", content: "Cloud replacement" }],
    });
    updateConversation(db, chat.id, {
      cloud_id: remote.id,
      sync_status: "synced",
      updated_at: LOCAL_EARLY,
    });
    const read = api.getConversationByClientId;
    api.getConversationByClientId = async (id) => {
      const row = await read(id);
      if (row?.id === chat.id) db.protectConversation(chat.id, [], true, "user-harness");
      return row;
    };
    await service.pullConversations(true);
    assert.deepEqual(
      db.getAgentConversation(chat.id).messages.map((row) => row.content),
      ["Keep local history"]
    );
  }
});

test("restored cloud history stays device-only through edits, forks, pagination and relaunch", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  for (let index = 0; index < 205; index++) {
    cloud.seedConversation({
      client_conversation_id: `restored-${index}`,
      title: "Restored",
      created_at: new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString(),
      messages: [{ role: "user", content: "OLD_PRIVATE_RESTORE_CANARY" }],
    });
  }
  // Even apparently future dates cannot establish provenance: cloud timestamps are client supplied.
  await service.pullConversations(true);
  assert.equal(
    db.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE device_only = 1").get()
      .count,
    205
  );
  const restored = db.getConversationByClientId("restored-0");
  const originalMessage = db.getAgentConversation(restored.id).messages[0];
  const fork = db.forkAgentConversation(restored.id, originalMessage.id);
  assert.equal(fork.device_only, 1);
  db.addAgentMessage(restored.id, "user", "PRIVATE_AFTER_RESTORE");
  db.updateAgentConversationTitle(restored.id, "Edited restored chat");
  db.addAgentMessage(fork.id, "user", "PRIVATE_FORK_AFTER_RESTORE");
  const ordinary = db.createAgentConversation("New ordinary local root");
  db.addAgentMessage(ordinary.id, "user", "Public local history");
  db.db.close();
  db.initDatabase();
  assert.equal(db.getAgentConversation(restored.id).device_only, 1);
  assert.equal(db.getAgentConversation(fork.id).device_only, 1);
  assert.equal(db.getAgentConversation(ordinary.id).device_only, 0);
  await service.pushConversation(restored.id);
  await service.pushConversation(fork.id);
  await service.pushPendingConversations();
  assert.deepEqual(cloudContents(cloud, "restored-0"), ["OLD_PRIVATE_RESTORE_CANARY"]);
  assert.equal(cloud.conversation(fork.client_conversation_id), null);
  assert.deepEqual(cloudContents(cloud, ordinary.client_conversation_id), ["Public local history"]);
  assert.equal(cloud.logFor("/api/conversations/delete").length, 0);
});

test("cloud reconciliation of a known new local chat preserves normal backup eligibility", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const local = db.createAgentConversation("Created here");
  db.addAgentMessage(local.id, "user", "Local message");
  cloud.seedConversation({
    client_conversation_id: local.client_conversation_id,
    title: "Reconciled",
    created_at: "2000-01-01T00:00:00.000Z",
    updated_at: "2099-01-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Cloud copy of my local message" }],
  });
  await service.pullConversations(true);
  assert.equal(db.getAgentConversation(local.id).device_only, 0);
  assert.equal(db.getAgentConversation(local.id).title, "Reconciled");
  db.addAgentMessage(local.id, "user", "Another public turn");
  updateConversation(db, local.id, { sync_status: "pending" });
  await service.pushPendingConversations();
  assert.deepEqual(cloudContents(cloud, local.client_conversation_id), [
    "Cloud copy of my local message",
    "Another public turn",
  ]);
});
