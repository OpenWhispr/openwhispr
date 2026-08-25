const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-gmail-db-"));
const originalLoad = Module._load;

// Deterministic secretCrypto stand-in: real backends hit the OS keychain.
let cryptoAvailable = true;
const fakeSecretCrypto = {
  isAvailable: () => cryptoAvailable,
  encrypt: (plaintext) => Buffer.from(`sealed:${plaintext}`, "utf8"),
  decrypt: (blob) => ({
    value: blob.toString("utf8").replace(/^sealed:/, ""),
    needsReencrypt: false,
  }),
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  if (request === "./secretCrypto") {
    return fakeSecretCrypto;
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-gmail-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

const tokens = (overrides = {}) => ({
  gmail_email: "me@example.com",
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_at: 1234567890,
  scope: "gmail.send",
  ...overrides,
});

test("gmail tokens are encrypted at rest and decrypted on read", (t) => {
  cryptoAvailable = true;
  const db = createDb(t);
  if (!db) return;

  db.saveGmailTokens(tokens());

  const rawRow = db.db.prepare("SELECT * FROM gmail_tokens").get();
  assert.ok(rawRow.access_token.startsWith("enc:"), "access token must not be stored plaintext");
  assert.ok(rawRow.refresh_token.startsWith("enc:"), "refresh token must not be stored plaintext");
  assert.ok(!rawRow.access_token.includes("access-1"));

  const row = db.getGmailTokens();
  assert.equal(row.access_token, "access-1");
  assert.equal(row.refresh_token, "refresh-1");
  assert.equal(row.gmail_email, "me@example.com");

  assert.equal(db.getAllGmailTokens()[0].refresh_token, "refresh-1");
  db.db.close();
});

test("gmail tokens fall back to plaintext when no encryption backend exists", (t) => {
  cryptoAvailable = false;
  const db = createDb(t);
  if (!db) return;

  db.saveGmailTokens(tokens());
  const rawRow = db.db.prepare("SELECT * FROM gmail_tokens").get();
  assert.equal(rawRow.access_token, "access-1");
  assert.equal(db.getGmailTokens().access_token, "access-1");

  cryptoAvailable = true;
  db.db.close();
});

test("connecting a different account replaces the previous one", (t) => {
  cryptoAvailable = true;
  const db = createDb(t);
  if (!db) return;

  db.saveGmailTokens(tokens());
  db.saveGmailTokens(tokens({ gmail_email: "other@example.com", access_token: "access-2" }));

  const rows = db.getAllGmailTokens();
  assert.equal(rows.length, 1, "gmail integration is single-account");
  assert.equal(rows[0].gmail_email, "other@example.com");
  assert.equal(rows[0].access_token, "access-2");
  db.db.close();
});

test("saving the same account refreshes tokens in place", (t) => {
  cryptoAvailable = true;
  const db = createDb(t);
  if (!db) return;

  db.saveGmailTokens(tokens());
  db.saveGmailTokens(tokens({ access_token: "access-refreshed" }));

  const rows = db.getAllGmailTokens();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].access_token, "access-refreshed");
  db.db.close();
});

test("deleteGmailTokens clears the table", (t) => {
  cryptoAvailable = true;
  const db = createDb(t);
  if (!db) return;

  db.saveGmailTokens(tokens());
  db.deleteGmailTokens();
  assert.equal(db.getGmailTokens(), null);
  db.db.close();
});

test("updateAgentToolCallMetadata patches a persisted draft in place", (t) => {
  cryptoAvailable = true;
  const db = createDb(t);
  if (!db) return;

  const conv = db.createAgentConversation("Test chat");
  const metadata = {
    toolCalls: [
      {
        id: "call-1",
        name: "draft_email",
        status: "completed",
        metadata: { subject: "Hi", body: "Draft", status: "draft" },
      },
    ],
  };
  db.addAgentMessage(conv.id, "assistant", "Drafted an email", metadata);

  const result = db.updateAgentToolCallMetadata("call-1", { status: "sent", subject: "Hello" });
  assert.equal(result.success, true);

  const stored = JSON.parse(
    db.db.prepare("SELECT metadata FROM agent_messages WHERE conversation_id = ?").get(conv.id)
      .metadata
  );
  assert.equal(stored.toolCalls[0].metadata.status, "sent");
  assert.equal(stored.toolCalls[0].metadata.subject, "Hello");
  assert.equal(stored.toolCalls[0].metadata.body, "Draft", "unpatched fields survive");

  assert.equal(db.updateAgentToolCallMetadata("missing-call", { status: "sent" }).success, false);
  db.db.close();
});
