const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CliAgentSessionStore } = require("../../src/helpers/cliAgent/sessionStore");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-sess-")), "sessions.json");
}

test("returns stored session within the window", () => {
  const store = new CliAgentSessionStore(tmpFile());
  store.set("claude-code", "sess-1");
  assert.equal(store.get("claude-code", 30), "sess-1");
});

test("returns null when entry is older than the window", () => {
  const file = tmpFile();
  const store = new CliAgentSessionStore(file);
  fs.writeFileSync(
    file,
    JSON.stringify({ "claude-code": { sessionId: "old", ts: Date.now() - 31 * 60_000 } })
  );
  assert.equal(store.get("claude-code", 30), null);
});

test("returns null when window is 0 (resume disabled)", () => {
  const store = new CliAgentSessionStore(tmpFile());
  store.set("codex", "sess-2");
  assert.equal(store.get("codex", 0), null);
});

test("clear removes only the given cli id", () => {
  const store = new CliAgentSessionStore(tmpFile());
  store.set("claude-code", "a");
  store.set("codex", "b");
  store.clear("claude-code");
  assert.equal(store.get("claude-code", 30), null);
  assert.equal(store.get("codex", 30), "b");
});

test("tolerates missing or corrupt file", () => {
  const store = new CliAgentSessionStore(tmpFile());
  assert.equal(store.get("claude-code", 30), null);
  const file = tmpFile();
  fs.writeFileSync(file, "not json");
  const store2 = new CliAgentSessionStore(file);
  assert.equal(store2.get("claude-code", 30), null);
  store2.set("claude-code", "x"); // must not throw
  assert.equal(store2.get("claude-code", 30), "x");
});
