const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db.js");

function seedConversation(db, title = "Plan the launch") {
  const conversation = db.createAgentConversation(title);
  const rows = [
    db.addAgentMessage(conversation.id, "user", "Draft the launch email"),
    db.addAgentMessage(conversation.id, "assistant", "Here is a draft.", {
      toolCalls: [{ id: "call-1", name: "search_notes", arguments: "{}", status: "completed" }],
      turn: { startedAt: 1, finishedAt: 2, status: "complete" },
    }),
    db.addAgentMessage(conversation.id, "user", "Make it shorter"),
    db.addAgentMessage(conversation.id, "assistant", "Shorter draft."),
  ];
  return { conversation, rows };
}

test("a fork copies the history through its message, in order, with metadata", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);

  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);

  assert.notEqual(fork.id, conversation.id);
  assert.equal(fork.title, "Plan the launch");
  assert.equal(fork.parent_conversation_id, conversation.id);
  assert.equal(fork.fork_message_id, rows[1].id);
  assert.equal(fork.fork_context, null);
  assert.equal(fork.parent_title, "Plan the launch");
  assert.notEqual(fork.client_conversation_id, null);
  assert.deepEqual(
    fork.messages.map((m) => [m.role, m.content]),
    [
      ["user", "Draft the launch email"],
      ["assistant", "Here is a draft."],
    ]
  );
  assert.deepEqual(JSON.parse(fork.messages[1].metadata).turn.status, "complete");
});

test("the original chat is untouched and both continue independently", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);

  const first = db.forkAgentConversation(conversation.id, rows[1].id, null);
  const second = db.forkAgentConversation(conversation.id, rows[3].id, "Shorter draft.");
  db.addAgentMessage(first.id, "user", "Only in the first fork");
  db.addAgentMessage(conversation.id, "user", "Only in the original");

  const original = db.getAgentConversation(conversation.id);
  assert.equal(original.messages.length, 5);
  assert.equal(original.parent_conversation_id, null);
  assert.equal(db.getAgentConversation(first.id).messages.length, 3);
  assert.equal(db.getAgentConversation(second.id).messages.length, 4);
  assert.equal(db.getAgentConversation(second.id).fork_context, "Shorter draft.");
  assert.equal(db.getAgentConversation(first.id).messages.at(-1).content, "Only in the first fork");
});

test("a fork refuses a message from another chat, and a deleted chat", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const other = seedConversation(db, "Other");

  assert.equal(db.forkAgentConversation(conversation.id, other.rows[0].id, null), null);
  db.deleteAgentConversation(conversation.id);
  assert.equal(db.forkAgentConversation(conversation.id, rows[0].id, null), null);
});

test("a fork is an ordinary chat in the list, marked with its parent", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);

  const list = db.getAgentConversationsWithPreview(50, 0, false);
  const listed = list.find((c) => c.id === fork.id);
  assert.equal(listed.parent_conversation_id, conversation.id);
  assert.equal(list.find((c) => c.id === conversation.id).parent_conversation_id, null);
  assert.ok(db.getPendingConversations().some((c) => c.id === fork.id));
  assert.ok(db.searchAgentConversations("launch").some((c) => c.id === fork.id));
});

test("a deleted parent leaves the fork without a parent title", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);
  db.deleteAgentConversation(conversation.id);

  const loaded = db.getAgentConversation(fork.id);
  assert.equal(loaded.parent_conversation_id, conversation.id);
  assert.equal(loaded.parent_title, null);
});

test("a pull from the cloud keeps a fork's local link", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const fork = db.forkAgentConversation(conversation.id, rows[1].id, "context");

  db.upsertConversationFromCloud(
    {
      id: "cloud-fork",
      client_conversation_id: fork.client_conversation_id,
      title: "Renamed in the cloud",
      updated_at: new Date().toISOString(),
    },
    [{ role: "user", content: "Draft the launch email" }]
  );

  const pulled = db.getAgentConversation(fork.id);
  assert.equal(pulled.title, "Renamed in the cloud");
  assert.equal(pulled.parent_conversation_id, conversation.id);
  assert.equal(pulled.fork_context, "context");
});

test("updating a message replaces its content and metadata in place", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);

  const updated = db.updateAgentMessage(rows[3].id, "Final answer", {
    turn: { startedAt: 1, finishedAt: 3, status: "complete" },
  });

  assert.equal(updated.id, rows[3].id);
  const messages = db.getAgentConversation(conversation.id).messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[3].content, "Final answer");
  assert.equal(JSON.parse(messages[3].metadata).turn.finishedAt, 3);
  assert.equal(db.updateAgentMessage(rows[3].id, "x", null).metadata, null);

  db.deleteAgentConversation(conversation.id);
  assert.equal(db.updateAgentMessage(rows[3].id, "after delete", null), null);
});

test("the fork columns migrate idempotently on an existing database", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.initDatabase();
  const columns = db.db
    .prepare("PRAGMA table_info(agent_conversations)")
    .all()
    .map((column) => column.name);
  for (const name of ["parent_conversation_id", "fork_message_id", "fork_context"]) {
    assert.equal(columns.filter((column) => column === name).length, 1);
  }
});
