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

test("history and search previews use the newest row when saved timestamps tie", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation } = seedConversation(db);
  db.db
    .prepare("UPDATE agent_messages SET created_at = ? WHERE conversation_id = ?")
    .run("2026-10-23 10:00:00", conversation.id);
  for (const rows of [
    db.getAgentConversationsWithPreview(),
    db.searchAgentConversations("launch"),
  ]) {
    const preview = rows.find((row) => row.id === conversation.id);
    assert.equal(preview.last_message, "Shorter draft.");
    assert.equal(preview.last_message_role, "assistant");
  }
});

test("a fork copies the history through its message, in order, with metadata", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);

  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);

  assert.notEqual(fork.id, conversation.id);
  assert.equal(fork.title, "Plan the launch");
  assert.equal(fork.parent_conversation_id, conversation.id);
  assert.equal(fork.parent_client_conversation_id, conversation.client_conversation_id);
  assert.equal(fork.fork_message_count, 2);
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

test("a fork knows how much of its history came from its parent", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);
  db.addAgentMessage(fork.id, "user", "Only in the fork");
  const forkOfFork = db.forkAgentConversation(fork.id, fork.messages[1].id, null);

  assert.equal(db.getAgentConversation(fork.id).fork_message_count, 2);
  assert.equal(forkOfFork.fork_message_count, 2);
  assert.equal(db.getAgentConversation(conversation.id).fork_message_count, null);
});

test("a fork keeps how much it copied when its parent is pulled again", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation, rows } = seedConversation(db);
  const fork = db.forkAgentConversation(conversation.id, rows[1].id, null);

  // A newer cloud copy of the parent replaces its messages with new rows.
  db.upsertConversationFromCloud(
    {
      id: "cloud-parent",
      client_conversation_id: conversation.client_conversation_id,
      title: "Renamed in the cloud",
      updated_at: new Date().toISOString(),
    },
    rows.map((row) => ({ role: row.role, content: row.content }))
  );

  assert.equal(db.getAgentConversation(fork.id).fork_message_count, 2);
});

function pullFork(db, clientId, parentClientId) {
  return db.upsertConversationFromCloud(
    {
      id: `cloud-${clientId}`,
      client_conversation_id: clientId,
      title: "Plan the launch",
      updated_at: new Date().toISOString(),
      parent_client_conversation_id: parentClientId,
      fork_message_count: 1,
      fork_context: "Draft",
    },
    [{ role: "user", content: "Draft the launch email" }]
  );
}

test("a pulled fork links to its parent by client id, whichever arrives first", (t) => {
  const db = createDb(t);
  if (!db) return;
  const fork = pullFork(db, "fork-chat", "parent-chat");
  assert.equal(db.getAgentConversation(fork.id).parent_conversation_id, null);

  const parent = db.upsertConversationFromCloud(
    {
      id: "cloud-parent-chat",
      client_conversation_id: "parent-chat",
      title: "Plan the launch",
      updated_at: new Date().toISOString(),
    },
    [{ role: "user", content: "Draft the launch email" }]
  );

  const linked = db.getAgentConversation(fork.id);
  assert.equal(linked.parent_conversation_id, parent.id);
  assert.equal(linked.parent_title, "Plan the launch");
  assert.equal(linked.fork_message_count, 1);
  assert.equal(linked.fork_context, "Draft");
  const later = pullFork(db, "second-fork", "parent-chat");
  assert.equal(db.getAgentConversation(later.id).parent_conversation_id, parent.id);
});

test("a pulled chat isn't its own parent, and its copied count fits its messages", (t) => {
  const db = createDb(t);
  if (!db) return;
  const self = pullFork(db, "loop-chat", "loop-chat");
  const own = db.getAgentConversation(self.id);
  assert.equal(own.parent_client_conversation_id, null);
  assert.equal(own.fork_message_count, null);

  const tooMany = db.upsertConversationFromCloud(
    {
      id: "cloud-big",
      client_conversation_id: "big-fork",
      title: "Plan the launch",
      updated_at: new Date().toISOString(),
      parent_client_conversation_id: "parent-chat",
      fork_message_count: 9,
    },
    [{ role: "user", content: "Draft the launch email" }]
  );
  assert.equal(db.getAgentConversation(tooMany.id).fork_message_count, 1);
  for (const count of [0, -2, 1.5, "three", null]) {
    const odd = db.upsertConversationFromCloud(
      {
        id: `cloud-odd-${count}`,
        client_conversation_id: `odd-${count}`,
        title: "Plan the launch",
        updated_at: new Date().toISOString(),
        parent_client_conversation_id: "parent-chat",
        fork_message_count: count,
      },
      [{ role: "user", content: "Draft the launch email" }]
    );
    assert.equal(db.getAgentConversation(odd.id).fork_message_count, null, String(count));
  }
  // An integer column can arrive as a string.
  const asText = db.upsertConversationFromCloud(
    {
      id: "cloud-text",
      client_conversation_id: "text-fork",
      title: "Plan the launch",
      updated_at: new Date().toISOString(),
      parent_client_conversation_id: "parent-chat",
      fork_message_count: "1",
    },
    [{ role: "user", content: "Draft the launch email" }]
  );
  assert.equal(db.getAgentConversation(asText.id).fork_message_count, 1);
});

test("two chats that name each other as parent don't both link", (t) => {
  const db = createDb(t);
  if (!db) return;
  const first = pullFork(db, "chat-a", "chat-b");
  const second = pullFork(db, "chat-b", "chat-a");
  const linked = [first, second].map((chat) => db.getAgentConversation(chat.id));
  assert.equal(linked.filter((chat) => chat.parent_conversation_id != null).length, 1);
});

// A pulled message's time is ISO ("…T…Z"), a local one SQLite's ("… …"):
// compared as text, a later local message of the same day would sort first,
// and the fork view (which hides its copied messages) would hide it instead.
test("messages added to a pulled chat stay after the pulled ones, by time", (t) => {
  const db = createDb(t);
  if (!db) return;
  const pulled = db.upsertConversationFromCloud(
    {
      id: "cloud-fork-chat",
      client_conversation_id: "fork-chat",
      title: "Plan the launch",
      updated_at: "2026-10-23T09:00:00.000Z",
      fork_message_count: 2,
    },
    [
      { role: "user", content: "Draft the launch email", created_at: "2026-10-23T09:00:00.000Z" },
      { role: "assistant", content: "Here is a draft.", created_at: "2026-10-23T09:00:05.000Z" },
    ]
  );
  const mine = db.addAgentMessage(pulled.id, "user", "Make it shorter");
  db.db
    .prepare("UPDATE agent_messages SET created_at = ? WHERE id = ?")
    .run("2026-10-23 10:00:00", mine.id);

  const order = (rows) => rows.map((message) => message.content);
  const expected = ["Draft the launch email", "Here is a draft.", "Make it shorter"];
  assert.deepEqual(order(db.getAgentConversation(pulled.id).messages), expected);
  assert.deepEqual(order(db.getAgentMessages(pulled.id)), expected);
  const preview = db.getAgentConversationsWithPreview().find((row) => row.id === pulled.id);
  assert.equal(preview.last_message, "Make it shorter");
});

test("a pulled fork whose parent was deleted here stays a plain chat", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { conversation } = seedConversation(db);
  db.deleteAgentConversation(conversation.id);

  const fork = pullFork(db, "fork-chat", conversation.client_conversation_id);

  assert.equal(db.getAgentConversation(fork.id).parent_conversation_id, null);
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
  for (const name of [
    "parent_conversation_id",
    "parent_client_conversation_id",
    "fork_message_count",
    "fork_context",
  ]) {
    assert.equal(columns.filter((column) => column === name).length, 1);
  }
});
