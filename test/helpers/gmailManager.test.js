const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/gmailManager.js");
const originalLoad = Module._load;

// Swapped per-test so mocked net.fetch calls route to the current stub.
let fetchImpl = async () => {
  throw new Error("fetch not stubbed");
};

function loadManagerModule() {
  delete require.cache[managerModulePath];
  delete require.cache[require.resolve("../../src/helpers/gmailOAuth.js")];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return {
        net: { fetch: (...args) => fetchImpl(...args) },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function decodeRaw(raw) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function splitMessage(raw) {
  const message = decodeRaw(raw);
  const [headerBlock, bodyBlock] = message.split("\r\n\r\n");
  return { headers: headerBlock.split("\r\n"), body: bodyBlock };
}

test("buildRawMessage produces base64url with full RFC 2822 framing", () => {
  const GmailManager = loadManagerModule();
  const raw = GmailManager.buildRawMessage({
    from: "me@example.com",
    to: ["a@example.com", "b@example.com"],
    cc: ["c@example.com"],
    subject: "Meeting follow-up",
    body: "Hi team,\nThanks for today.",
  });

  assert.match(raw, /^[A-Za-z0-9_-]+$/, "raw must use the base64url alphabet only");

  const { headers, body } = splitMessage(raw);
  assert.ok(headers.includes("From: me@example.com"));
  assert.ok(headers.includes("To: a@example.com, b@example.com"));
  assert.ok(headers.includes("Cc: c@example.com"));
  assert.ok(headers.includes("Subject: Meeting follow-up"));
  assert.ok(headers.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(headers.includes("Content-Transfer-Encoding: base64"));

  const decodedBody = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(decodedBody, "Hi team,\nThanks for today.");
});

test("buildRawMessage RFC 2047-encodes non-ASCII subjects and preserves UTF-8 bodies", () => {
  const GmailManager = loadManagerModule();
  const raw = GmailManager.buildRawMessage({
    from: "me@example.com",
    to: ["a@example.com"],
    subject: "Résumé — 会議",
    body: "Danke schön — ありがとう",
  });

  const { headers, body } = splitMessage(raw);
  const subjectHeader = headers.find((h) => h.startsWith("Subject: "));
  const match = subjectHeader.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/);
  assert.ok(match, `subject must be B-encoded, got: ${subjectHeader}`);
  assert.equal(Buffer.from(match[1], "base64").toString("utf8"), "Résumé — 会議");

  const decodedBody = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(decodedBody, "Danke schön — ありがとう");
});

test("buildRawMessage omits the Cc header when there are no cc recipients", () => {
  const GmailManager = loadManagerModule();
  const raw = GmailManager.buildRawMessage({
    from: "me@example.com",
    to: ["a@example.com"],
    subject: "No cc",
    body: "body",
  });
  const { headers } = splitMessage(raw);
  assert.ok(!headers.some((h) => h.startsWith("Cc:")));
});

test("sendEmail rejects when Gmail is not connected", async () => {
  const GmailManager = loadManagerModule();
  const manager = new GmailManager({ getGmailTokens: () => null });
  await assert.rejects(() => manager.sendEmail({ to: ["a@b.co"], subject: "s", body: "b" }), {
    message: "Gmail is not connected",
  });
});

test("sendEmail posts the raw message with a bearer token and returns the message id", async () => {
  const GmailManager = loadManagerModule();
  const manager = new GmailManager({
    getGmailTokens: () => ({ gmail_email: "me@example.com" }),
  });
  manager.oauth.getValidAccessToken = async () => "access-token-1";

  const calls = [];
  fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, text: async () => JSON.stringify({ id: "msg-1" }) };
  };

  const result = await manager.sendEmail({
    to: ["a@example.com"],
    subject: "Hello",
    body: "World",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token-1");
  const payload = JSON.parse(calls[0].options.body);
  const { headers } = splitMessage(payload.raw);
  assert.ok(headers.includes("From: me@example.com"));
  assert.deepEqual(result, { messageId: "msg-1" });
});

test("sendEmail surfaces Gmail API errors with the status code", async () => {
  const GmailManager = loadManagerModule();
  const manager = new GmailManager({
    getGmailTokens: () => ({ gmail_email: "me@example.com" }),
  });
  manager.oauth.getValidAccessToken = async () => "access-token-1";

  fetchImpl = async () => ({
    status: 403,
    text: async () => JSON.stringify({ error: { message: "Quota exceeded" } }),
  });

  await assert.rejects(
    () => manager.sendEmail({ to: ["a@example.com"], subject: "s", body: "b" }),
    (err) => err.message === "Quota exceeded" && err.statusCode === 403
  );
});

test("getConnectionStatus reflects tokens and client configuration", () => {
  const GmailManager = loadManagerModule();
  const prevId = process.env.GMAIL_CLIENT_ID;
  const prevSecret = process.env.GMAIL_CLIENT_SECRET;
  process.env.GMAIL_CLIENT_ID = "id";
  process.env.GMAIL_CLIENT_SECRET = "secret";
  try {
    const connected = new GmailManager({
      getGmailTokens: () => ({ gmail_email: "me@example.com" }),
    });
    assert.deepEqual(connected.getConnectionStatus(), {
      connected: true,
      email: "me@example.com",
      configured: true,
    });

    const disconnected = new GmailManager({ getGmailTokens: () => null });
    assert.deepEqual(disconnected.getConnectionStatus(), {
      connected: false,
      email: null,
      configured: true,
    });
  } finally {
    if (prevId === undefined) delete process.env.GMAIL_CLIENT_ID;
    else process.env.GMAIL_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
    else process.env.GMAIL_CLIENT_SECRET = prevSecret;
  }
});

test("disconnect deletes stored tokens", () => {
  const GmailManager = loadManagerModule();
  let deleted = false;
  const manager = new GmailManager({
    getGmailTokens: () => null,
    deleteGmailTokens: () => {
      deleted = true;
      return { success: true };
    },
  });
  manager.disconnect();
  assert.equal(deleted, true);
});
