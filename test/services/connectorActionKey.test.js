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
