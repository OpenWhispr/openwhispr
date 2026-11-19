const test = require("node:test");
const assert = require("node:assert/strict");

test("action keys preserve case and whitespace in approved content", async () => {
  const { connectorActionKey } = await import("../../src/services/tools/connectors/actionKey.ts");
  for (const [connector, action, field] of [
    ["slack", "send_message", "text"],
    ["gmail", "send", "body"],
    ["gmail", "send", "subject"],
    ["github", "create_issue", "body"],
    ["linear", "create_issue", "description"],
  ]) {
    const key = (value) =>
      connectorActionKey(connector, action, { destination: "#eng", [field]: value });
    assert.notEqual(key("The token is AbC123"), key("The token is abc123"), field);
    assert.notEqual(key("if ready:\n  send()"), key("if ready: send()"), field);
    assert.equal(key("Same exact message"), key("Same exact message"), field);
  }
});

test("destination spelling and recipient order still identify the same action", async () => {
  const { connectorActionKey } = await import("../../src/services/tools/connectors/actionKey.ts");
  assert.equal(
    connectorActionKey("gmail", "send", {
      to: ["A@example.test", "b@example.test"],
      body: "Exact body",
    }),
    connectorActionKey("gmail", "send", {
      body: "Exact body",
      to: ["b@example.test", "a@example.test"],
    })
  );
  assert.equal(
    connectorActionKey("slack", "send_message", {
      destination: " #Engineering ",
      text: "Exact message",
    }),
    connectorActionKey("slack", "send_message", {
      destination: "#engineering",
      text: "Exact message",
    })
  );
});

test("Slack replies through message links to two threads are two actions", async () => {
  const { approvalActionKey } = await import("../../src/services/tools/connectors/actionKey.ts");
  const key = (destination, started, thread) =>
    approvalActionKey(
      "slack",
      "send_message",
      { destination, text: "Thanks!", ...(thread ? { thread } : {}) },
      {
        destinationLabel: "#eng",
        body: "Thanks!",
        ...(started
          ? {
              notes: [
                { key: "connectors.approval.slack.notes.replyInThread", values: { started } },
              ],
            }
          : {}),
      }
    );
  const root = key("#eng");
  const first = key("https://acme.slack.com/archives/C0ENG/p1727200000123456", "1727200000123");
  const second = key("https://acme.slack.com/archives/C0ENG/p1727200500000100", "1727200500000");
  assert.notEqual(first, second);
  assert.notEqual(first, root);
  assert.equal(key("C0ENG"), root, "a post at the root keys as before");
  // The same thread through a thread link, or through a link to a reply in it.
  assert.equal(
    key("#eng", "1727200000123", "https://acme.slack.com/archives/C0ENG/p1727200000123456"),
    first
  );
  assert.equal(
    key(
      "#eng",
      "1727200000123",
      "https://acme.slack.com/archives/C0ENG/p1727200099000200?thread_ts=1727200000.123456"
    ),
    first
  );
});
