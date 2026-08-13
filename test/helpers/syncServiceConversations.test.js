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
