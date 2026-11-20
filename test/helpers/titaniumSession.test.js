const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const golden = require("../fixtures/titanium/golden-vectors.json");
const { TitaniumSession } = require("../../src/helpers/titanium/titaniumSession");

const VALID_KEY = golden.vectors.find((v) => v.id === "valid-perpetual").input;
const CONFIG = {
  portalUrl: "https://auth.example.test",
  appSlug: "titanium-whisper",
  keygenProductId: golden.keygenProductId,
  publicKey: golden.publicKeyHex,
};

function makeSession({ exchange, config = CONFIG, now = () => 1_700_000_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-session-"));
  const opened = [];
  const requests = [];
  const session = new TitaniumSession({
    config,
    urlScheme: "titaniumwhisper",
    filePath: path.join(dir, "titanium-session.bin"),
    encrypt: (text) => Buffer.from(`enc:${text}`),
    decrypt: (buf) => {
      const text = buf.toString();
      assert.ok(text.startsWith("enc:"), "stored encrypted");
      return text.slice(4);
    },
    openExternal: async (url) => opened.push(url),
    now,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const { status = 200, body } = exchange(JSON.parse(init.body));
      // The portal always echoes appSlug; a test overrides it (or sets undefined) to probe.
      const echoed = status < 400 ? { appSlug: CONFIG.appSlug, ...body } : body;
      return { ok: status < 400, status, json: async () => echoed };
    },
  });
  return { session, opened, requests, dir };
}

function callbackFor(loginUrl, params) {
  const returnUrl = new URL(new URL(loginUrl).searchParams.get("return_url"));
  for (const [k, v] of Object.entries(params)) returnUrl.searchParams.set(k, v);
  return returnUrl.toString();
}

test("sign-in opens the hosted login with a PKCE return_url on our scheme", async () => {
  const { session, opened } = makeSession({ exchange: () => ({ body: {} }) });
  await session.startSignIn();
  const login = new URL(opened[0]);
  assert.equal(login.origin + login.pathname, "https://auth.example.test/login");
  assert.equal(login.searchParams.get("app_id"), "titanium-whisper");
  const ret = new URL(login.searchParams.get("return_url"));
  assert.equal(
    `${ret.protocol}//${ret.hostname}${ret.pathname}`,
    "titaniumwhisper://auth/callback"
  );
  assert.match(ret.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ret.searchParams.get("code_challenge_method"), "S256");
  assert.ok(ret.searchParams.get("state"));
  assert.equal(session.getState().pending, true);
});

test("callback exchanges act with the matching verifier and verifies the license offline", async () => {
  const { session, opened, requests } = makeSession({
    exchange: () => ({
      body: { licenseKey: VALID_KEY, email: "a@b.test", appSlug: "titanium-whisper" },
    }),
  });
  await session.startSignIn();
  const challenge = new URL(new URL(opened[0]).searchParams.get("return_url")).searchParams.get(
    "code_challenge"
  );
  const result = await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));

  assert.equal(result.ok, true);
  assert.equal(requests[0].url, "https://auth.example.test/api/exchange");
  assert.equal(requests[0].body.act, "act_1");
  const computed = crypto
    .createHash("sha256")
    .update(requests[0].body.code_verifier, "ascii")
    .digest("base64url");
  assert.equal(computed, challenge, "verifier matches the challenge sent to the portal");

  const state = session.getState();
  assert.equal(state.signedIn, true);
  assert.equal(state.email, "a@b.test");
  assert.equal(state.licensed, true);
  assert.equal(state.pending, false);
  assert.equal(session.getLicenseKey(), VALID_KEY);
});

test("a callback with the wrong state never reaches the portal", async () => {
  const { session, opened, requests } = makeSession({ exchange: () => ({ body: {} }) });
  await session.startSignIn();
  const result = await session.handleCallback(
    callbackFor(opened[0], { act: "act_1", state: "forged" })
  );
  assert.deepEqual(result, { ok: false, error: "state_mismatch" });
  assert.equal(requests.length, 0);
  assert.equal(session.getState().signedIn, false);
});

test("a callback with no sign-in in progress is refused", async () => {
  const { session, requests } = makeSession({ exchange: () => ({ body: {} }) });
  const result = await session.handleCallback("titaniumwhisper://auth/callback?act=x&state=y");
  assert.deepEqual(result, { ok: false, error: "no_pending_sign_in" });
  assert.equal(requests.length, 0);
});

test("a duplicate callback after a completed sign-in leaves no error", async () => {
  const { session, opened, requests } = makeSession({
    exchange: () => ({ body: { licenseKey: VALID_KEY, email: "a@b.test" } }),
  });
  await session.startSignIn();
  const callback = callbackFor(opened[0], { act: "act_1" });
  assert.equal((await session.handleCallback(callback)).ok, true);
  const again = await session.handleCallback(callback);
  assert.deepEqual(again, { ok: false, error: "no_pending_sign_in" });
  assert.equal(requests.length, 1);
  assert.equal(session.getState().signedIn, true);
  assert.equal(session.getState().error, null);
});

test("a stale sign-in (over 10 minutes) is refused", async () => {
  let t = 1_700_000_000_000;
  const { session, opened } = makeSession({ exchange: () => ({ body: {} }), now: () => t });
  await session.startSignIn();
  t += 10 * 60 * 1000;
  const result = await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.equal(result.error, "no_pending_sign_in");
});

test("signed in without a license is a normal state, not an error", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: null, email: "a@b.test" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  const state = session.getState();
  assert.equal(state.signedIn, true);
  assert.equal(state.licensed, false);
  assert.equal(state.reason, "no_license");
  assert.equal(state.error, null);
  assert.equal(session.getLicenseKey(), null);
});

test("a license for another product is not used", async () => {
  const wrong = golden.vectors.find((v) => v.id === "wrong-product").input;
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: wrong, email: "a@b.test" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.equal(session.getState().reason, "audience_mismatch");
  assert.equal(session.getLicenseKey(), null);
});

test("an exchange error is reported and leaves the user signed out", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ status: 400, body: { error: "invalid_code_verifier" } }),
  });
  await session.startSignIn();
  const result = await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.deepEqual(result, { ok: false, error: "invalid_code_verifier" });
  assert.equal(session.getState().signedIn, false);
  assert.equal(session.getState().error, "invalid_code_verifier");
});

test("the session survives a restart, encrypted, and sign out removes it", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: VALID_KEY, email: "a@b.test" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.ok(fs.readFileSync(session.filePath, "utf8").startsWith("enc:"), "written via encrypt()");

  const reloaded = new TitaniumSession({
    config: CONFIG,
    urlScheme: "titaniumwhisper",
    filePath: session.filePath,
    encrypt: session.encrypt,
    decrypt: session.decrypt,
    now: session.now,
    openExternal: async () => {},
  });
  assert.equal(reloaded.load().email, "a@b.test");
  assert.equal(reloaded.getState().licensed, true);

  reloaded.signOut();
  assert.equal(fs.existsSync(session.filePath), false);
  assert.equal(reloaded.getState().signedIn, false);
});

test("with no OS encryption the session stays in memory only", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: null, email: "a@b.test" } }),
  });
  session.encrypt = () => null;
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.equal(session.getState().signedIn, true);
  assert.equal(fs.existsSync(session.filePath), false);
});

test("only <scheme>://auth/callback is a Titanium callback", () => {
  const { session } = makeSession({ exchange: () => ({ body: {} }) });
  assert.equal(session.isCallbackUrl("titaniumwhisper://auth/callback?act=1"), true);
  assert.equal(session.isCallbackUrl("titaniumwhisper://notes/abc"), false);
  assert.equal(session.isCallbackUrl("openwhispr://auth/callback?act=1"), false);
});

test("an exchange that finishes after a newer sign-in or a sign-out is ignored", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: null, email: "old@b.test" } }),
  });
  const slowFetch = session.fetchImpl;
  session.fetchImpl = async (...args) => {
    await gate;
    return slowFetch(...args);
  };
  await session.startSignIn();
  const inFlight = session.handleCallback(callbackFor(opened[0], { act: "act_old" }));
  session.signOut();
  release();
  assert.deepEqual(await inFlight, { ok: false, error: "superseded" });
  assert.equal(session.getState().signedIn, false);
  assert.equal(fs.existsSync(session.filePath), false);
});

test("the exchange sends app_slug and stores the account id, never exposing it in state", async () => {
  const { session, opened, requests } = makeSession({
    exchange: () => ({ body: { licenseKey: VALID_KEY, email: "a@b.test", accountId: "acc_1" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.equal(requests[0].body.app_slug, "titanium-whisper");
  assert.deepEqual(session.getAccountScope(), {
    accountId: "acc_1",
    authGeneration: session.generation,
  });
  const state = session.getState();
  assert.equal(state.accountBound, true);
  assert.ok(!JSON.stringify(state).includes("acc_1"), "raw id stays in main");
});

test("an exchange without an account id is signed in but unbound", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: VALID_KEY, email: "a@b.test", accountId: "" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  assert.equal(session.getState().signedIn, true);
  assert.equal(session.getState().accountBound, false);
  assert.equal(session.getAccountScope(), null);
});

test("the account id round-trips through persist and load; an old file loads unbound", async () => {
  const { session, opened } = makeSession({
    exchange: () => ({ body: { licenseKey: null, email: "a@b.test", accountId: "acc_9" } }),
  });
  await session.startSignIn();
  await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
  const make = () =>
    new TitaniumSession({
      config: CONFIG,
      urlScheme: "titaniumwhisper",
      filePath: session.filePath,
      encrypt: session.encrypt,
      decrypt: session.decrypt,
      now: session.now,
      openExternal: async () => {},
    });
  const reloaded = make();
  reloaded.load();
  assert.equal(reloaded.getAccountScope().accountId, "acc_9");

  // A session file written before Phase 7 has no accountId.
  fs.writeFileSync(
    session.filePath,
    Buffer.from(`enc:${JSON.stringify({ email: "a@b.test", licenseKey: null })}`)
  );
  const legacy = make();
  legacy.load();
  assert.equal(legacy.getState().signedIn, true);
  assert.equal(legacy.getState().accountBound, false);
  assert.equal(legacy.getAccountScope(), null);
});

test("a response whose appSlug is missing or different is rejected and stores nothing", async () => {
  for (const appSlug of [undefined, "other-app"]) {
    const { session, opened } = makeSession({
      exchange: () => ({ body: { email: "a@b.test", accountId: "acc_1", appSlug } }),
    });
    await session.startSignIn();
    const result = await session.handleCallback(callbackFor(opened[0], { act: "act_1" }));
    assert.deepEqual(result, { ok: false, error: "app_mismatch" });
    assert.equal(session.getState().signedIn, false);
    assert.equal(session.getAccountScope(), null);
    assert.equal(fs.existsSync(session.filePath), false);
  }
});
