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

test("a conversation changed during create retries with its complete message history", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const conversation = db.createAgentConversation("In-flight conversation");
  db.addAgentMessage(conversation.id, "user", "first message");
  const gate = pauseNextConversationCreate(api);

  const firstSync = service.syncAll(true);
  await gate.started;
  db.addAgentMessage(conversation.id, "assistant", "late message");
  gate.resume();
  await firstSync;

  const pending = db.getAgentConversation(conversation.id);
  assert.equal(pending.cloud_id, null);
  assert.equal(pending.sync_status, "pending");
  assert.equal(cloud.logFor("/api/conversations/delete").length, 1);

  await service.syncAll(true);

  const creates = cloud.logFor("/api/conversations/create");
  assert.equal(creates.length, 2);
  assert.deepEqual(
    creates[1].body.messages.map((message) => message.content),
    ["first message", "late message"]
  );
  const synced = db.getAgentConversation(conversation.id);
  assert.ok(synced.cloud_id);
  assert.equal(synced.sync_status, "synced");

  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/conversations/create").length, 2);
});

test("a losing concurrent conversation create is deleted without replacing the winner", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, api, service } = ctx;
  const conversation = db.createAgentConversation("Concurrent conversation");
  db.addAgentMessage(conversation.id, "user", "hello");
  const gate = pauseNextConversationCreate(api);

  const sync = service.syncAll(true);
  await gate.started;
  db.markConversationSynced(conversation.id, "cloud-winner");
  gate.resume();
  await sync;

  const current = db.getAgentConversation(conversation.id);
  assert.equal(current.cloud_id, "cloud-winner");
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

test("a fork is pushed with its parent's client id, its copied count and its text", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const { parent, fork } = seedForkedChat(db);

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
  assert.equal(pushedFork.messages.length, 2);
  const pushedParent = bodies.get(parent.client_conversation_id);
  assert.equal(pushedParent.parent_client_conversation_id, null);
  assert.equal(pushedParent.fork_message_count, null);
  assert.equal(pushedParent.fork_context, null);
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
