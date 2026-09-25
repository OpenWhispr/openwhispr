const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/emailConnector.js");

function fakes() {
  const calls = { opened: [], copied: [] };
  return {
    calls,
    deps: {
      openExternal: async (url) => calls.opened.push(url),
      writeClipboard: async (text, webContents) => calls.copied.push({ text, webContents }),
      // The strictest link limit (2,000 for every target).
      platform: "win32",
    },
  };
}

test("a draft opens the compose URL and never returns it", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const connector = createEmailConnector(deps);

  const result = await connector.runDirect(
    "draft",
    { target: "gmail", to: ["gabe@example.com"], cc: [], subject: "Lunch", body: "Tomorrow at 1?" },
    { webContents: "sender" }
  );

  assert.deepEqual(result, {
    state: "sent",
    destinationLabel: "gabe@example.com",
    bodyCopied: false,
    subjectCopied: false,
    copyFailed: false,
  });
  assert.equal(calls.opened.length, 1);
  assert.match(calls.opened[0], /^https:\/\/mail\.google\.com\//);
  assert.equal(calls.copied.length, 0);
});

test("a long body goes to the clipboard through the caller's window", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const connector = createEmailConnector(deps);
  const body = "word ".repeat(600);

  const result = await connector.runDirect(
    "draft",
    { target: "mailto", to: ["a@example.com"], subject: "Notes", body, clipboardReserved: true },
    { webContents: "sender" }
  );

  assert.equal(result.bodyCopied, true);
  assert.equal(result.subjectCopied, false);
  assert.deepEqual(calls.copied, [{ text: body, webContents: "sender" }]);
  assert.doesNotMatch(calls.opened[0], /body=/);
});

test("a subject too long for a link goes to the clipboard with the body", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const subject = "Planning ".repeat(300).trim();

  const result = await createEmailConnector(deps).runDirect(
    "draft",
    { target: "gmail", to: ["a@example.com"], subject, body: "Agenda", clipboardReserved: true },
    { webContents: "sender" }
  );

  assert.equal(result.subjectCopied, true);
  assert.equal(result.bodyCopied, true);
  assert.deepEqual(calls.copied, [{ text: `${subject}\n\nAgenda`, webContents: "sender" }]);
  assert.ok(calls.opened[0].length <= 2000);
});

test("a subject too long for a link with no body copies only the subject", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const subject = "Planning ".repeat(300).trim();

  const result = await createEmailConnector(deps).runDirect(
    "draft",
    { target: "gmail", to: ["a@example.com"], subject, clipboardReserved: true },
    {}
  );

  assert.equal(result.subjectCopied, true);
  assert.equal(result.bodyCopied, false);
  assert.deepEqual(calls.copied, [{ text: subject, webContents: null }]);
});

test("a draft that needs the clipboard opens nothing unless the turn reserved it", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();

  const result = await createEmailConnector(deps).runDirect(
    "draft",
    { target: "mailto", to: ["a@example.com"], subject: "Notes", body: "word ".repeat(600) },
    {}
  );

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "clipboard_unreserved");
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.copied.length, 0);
});

test("a clipboard write that fails still reports the opened draft, without the text", async () => {
  const { createEmailConnector } = await load();
  const opened = [];
  const connector = createEmailConnector({
    openExternal: async (url) => opened.push(url),
    writeClipboard: async () => {
      throw new Error("clipboard locked");
    },
    platform: "win32",
  });

  const result = await connector.runDirect(
    "draft",
    { target: "mailto", to: ["a@example.com"], body: "word ".repeat(600), clipboardReserved: true },
    {}
  );

  assert.equal(opened.length, 1);
  assert.deepEqual(result, {
    state: "sent",
    destinationLabel: "a@example.com",
    bodyCopied: false,
    subjectCopied: false,
    copyFailed: true,
  });
});

test("on Linux, a mailto draft with no default mail app opens nothing", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  let queried = 0;
  const connector = createEmailConnector({
    ...deps,
    platform: "linux",
    hasMailtoHandler: async () => {
      queried += 1;
      return false;
    },
  });
  const draft = { to: ["a@example.com"], body: "word ".repeat(600), clipboardReserved: true };

  const result = await connector.runDirect("draft", { ...draft, target: "mailto" }, {});
  assert.equal(result.errorCode, "open_failed");
  assert.match(result.message, /default email app/);
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.copied.length, 0);

  // Web targets don't need a local mail app.
  await connector.runDirect("draft", { ...draft, target: "gmail" }, {});
  assert.equal(queried, 1);
  assert.equal(calls.opened.length, 1);
});

test("on Linux, a mailto draft opens when a mail app handles mailto", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const connector = createEmailConnector({
    ...deps,
    platform: "linux",
    hasMailtoHandler: async () => true,
  });

  const result = await connector.runDirect(
    "draft",
    { target: "mailto", to: ["a@example.com"] },
    {}
  );

  assert.equal(result.state, "sent");
  assert.match(calls.opened[0], /^mailto:/);
});

test("too many recipients for any link opens nothing", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const to = Array.from({ length: 120 }, (_, i) => `teammate.number.${i}@example.com`);

  const result = await createEmailConnector(deps).runDirect(
    "draft",
    { target: "mailto", to, subject: "Hi" },
    {}
  );

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "draft_too_long");
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.copied.length, 0);
});

test("a name instead of an address is refused before anything opens", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  const connector = createEmailConnector(deps);

  const result = await connector.runDirect(
    "draft",
    { target: "gmail", to: ["Gabe"], subject: "x", body: "y" },
    {}
  );

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "invalid_address");
  assert.equal(calls.opened.length, 0);
});

test("an unknown target falls back to the default mail app", async () => {
  const { createEmailConnector } = await load();
  const { calls, deps } = fakes();
  await createEmailConnector(deps).runDirect(
    "draft",
    { target: "yahoo", to: ["a@example.com"] },
    {}
  );
  assert.match(calls.opened[0], /^mailto:/);
});

test("a failure to open the mail app is reported, not thrown", async () => {
  const { createEmailConnector } = await load();
  const connector = createEmailConnector({
    openExternal: async () => {
      throw new Error("no handler");
    },
    writeClipboard: async () => {},
    platform: "win32",
  });
  const result = await connector.runDirect(
    "draft",
    { target: "mailto", to: ["a@example.com"] },
    {}
  );
  assert.equal(result.errorCode, "open_failed");
  // The receipt still says whose draft didn't open.
  assert.equal(result.destinationLabel, "a@example.com");
});

test("a draft that fails to open leaves the user's clipboard alone", async () => {
  const { createEmailConnector } = await load();
  const copied = [];
  const connector = createEmailConnector({
    openExternal: async () => {
      throw new Error("no handler");
    },
    writeClipboard: async (text) => copied.push(text),
    platform: "win32",
  });
  const result = await connector.runDirect(
    "draft",
    {
      target: "mailto",
      to: ["a@example.com"],
      subject: "Notes",
      body: "word ".repeat(600),
      clipboardReserved: true,
    },
    {}
  );
  assert.equal(result.errorCode, "open_failed");
  assert.deepEqual(copied, []);
});

test("the email connector is always connected and has no approval actions", async () => {
  const { createEmailConnector } = await load();
  const connector = createEmailConnector(fakes().deps);
  assert.deepEqual(await connector.getStatus(), { connected: true, accountLabel: null });
  assert.deepEqual(connector.actions, { draft: { kind: "direct" } });
});
