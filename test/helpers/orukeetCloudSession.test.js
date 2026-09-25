const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { OrukeetStreaming } = require("../../src/helpers/orukeetStreaming");
const {
  connectManagedOrukeet,
  ORUKEET_BASE_URL,
  validateSession,
} = require("../../src/helpers/orukeetCloudSession");
const { withPolicyRequestHeaders } = require("../../src/helpers/policyRequestHeaders");

const session = () => ({
  baseUrl: ORUKEET_BASE_URL,
  websocketUrl: "wss://orukeet.gizmovoice.ai/v1/audio/transcriptions/stream",
  clientToken: "test.single-use.token",
  protocol: "orukeet.pcm.v1",
  model: "orukeet-v0.1.0",
  singleUse: true,
  expiresIn: 60,
});

function authStore() {
  let state = { token: "account-a", generation: 1 };
  const listeners = new Set();
  return {
    getState: () => ({ ...state }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    change(token) {
      state = { token, generation: state.generation + 1 };
      for (const fn of listeners) fn(state);
    },
    count: () => listeners.size,
  };
}

async function fixture(t, fetchImpl) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const seen = [];
  const sockets = [];
  server.on("connection", (socket, req) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(
      req.headers["sec-websocket-protocol"],
      "orukeet.pcm.v1,auth.test.single-use.token"
    );
    socket.send(
      JSON.stringify({
        type: "ready",
        channels: 1,
        sample_rate: 16000,
        encoding: "pcm_s16le",
        max_seconds: 600,
      })
    );
    socket.on("message", (data, binary) => {
      const event = binary ? Buffer.from(data) : JSON.parse(data);
      seen.push(event);
      if (event.type === "commit")
        socket.send(JSON.stringify({ type: "final", text: "Full recording." }));
    });
  });
  const streaming = new OrukeetStreaming({
    timeoutMs: 500,
    createSocket(url, options, protocols) {
      sockets.push(url);
      assert.equal(url, session().websocketUrl);
      return new WebSocket(`ws://127.0.0.1:${server.address().port}`, protocols, options);
    },
  });
  streaming.beginConnecting();
  const tokenStore = authStore();
  const options = {
    streaming,
    tokenStore,
    getApiUrl: () => "https://api.openwhispr.test",
    withPolicyHeaders: (headers) => withPolicyRequestHeaders(headers, "1.8.1"),
    proxyFetch:
      fetchImpl ||
      (async (url, options) => {
        assert.equal(url, "https://api.openwhispr.test/api/stt/orukeet/session");
        assert.equal(options.headers.Authorization, "Bearer account-a");
        assert.equal(options.headers["x-openwhispr-policy-version"], "1");
        // The server mints only for builds that declare they can run Orukeet.
        assert.equal(options.headers["x-openwhispr-capabilities"], "orukeet");
        assert.equal(options.useSessionCookies, false);
        assert.equal(options.redirect, "error");
        return Response.json(session());
      }),
  };
  t.after(async () => {
    await streaming.disconnect();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(tokenStore.count(), 0);
  });
  return { options, streaming, seen, sockets, tokenStore };
}

test("managed auth and token handshake preserve PCM captured during session setup", async (t) => {
  const f = await fixture(t);
  f.streaming.sendAudio(Buffer.from([1, 0]));
  await connectManagedOrukeet(f.options);
  f.streaming.sendAudio(Buffer.from([2, 0]));
  assert.equal((await f.streaming.finalize()).text, "Full recording.");
  assert.deepEqual(f.seen, [Buffer.from([1, 0]), Buffer.from([2, 0]), { type: "commit" }]);
});

test("signed out users never request a session or open a socket", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
  });
  f.tokenStore.change(null);
  await assert.rejects(connectManagedOrukeet(f.options), { code: "AUTH_CONTEXT_UNVALIDATED" });
  assert.equal(calls, 0);
  assert.equal(f.sockets.length, 0);
});

for (const [status, code] of [
  [401, "AUTH_EXPIRED"],
  [403, "POLICY_RESTRICTED"],
  [402, "LIMIT_EXCEEDED"],
  [429, "RATE_LIMITED"],
  [426, "UPGRADE_REQUIRED"],
]) {
  test(`cloud denial ${status} preserves policy metadata and never connects`, async (t) => {
    const f = await fixture(t, async () =>
      Response.json({ error: "Denied", code, data: { minAppVersion: "2.0.0" } }, { status })
    );
    await assert.rejects(connectManagedOrukeet(f.options), { code, status });
    assert.equal(f.sockets.length, 0);
  });
}

test("a language exclusion keeps FEATURE_NOT_ENABLED for the batch fallback", async (t) => {
  const f = await fixture(t, async () =>
    Response.json(
      {
        error: "Orukeet dictation is not enabled for this account",
        code: "FEATURE_NOT_ENABLED",
        reason: "language_unsupported",
      },
      { status: 403 }
    )
  );
  await assert.rejects(connectManagedOrukeet(f.options), {
    code: "FEATURE_NOT_ENABLED",
    status: 403,
  });
  assert.equal(f.sockets.length, 0);
});

test("the weekly word quota surfaces as LIMIT_REACHED with its usage, not the mint cap", async (t) => {
  const f = await fixture(t, async () =>
    Response.json(
      { error: "Weekly word limit reached", limitReached: true, wordsUsed: 2000, limit: 2000 },
      { status: 429 }
    )
  );
  await assert.rejects(connectManagedOrukeet(f.options), {
    code: "LIMIT_REACHED",
    status: 429,
    message: "Weekly word limit reached",
    details: { wordsUsed: 2000, limit: 2000 },
  });
  assert.equal(f.sockets.length, 0);
});

for (const cancellation of ["logout", "cancel"]) {
  test(`${cancellation} while a token request is pending cannot reopen a session`, async (t) => {
    let release;
    const f = await fixture(
      t,
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = connectManagedOrukeet(f.options);
    const rejected = assert.rejects(pending, /context changed|cancelled/i);
    if (cancellation === "logout") f.tokenStore.change(null);
    else await f.streaming.disconnect();
    release(Response.json(session()));
    await rejected;
    assert.equal(f.sockets.length, 0);
  });
}

test("account switch closes an established managed socket without commit", async (t) => {
  const f = await fixture(t);
  await connectManagedOrukeet(f.options);
  f.streaming.sendAudio(Buffer.alloc(640));
  f.tokenStore.change("account-b");
  await assert.rejects(f.streaming.finalize(), { code: "AUTH_CONTEXT_CHANGED" });
  assert.equal(f.streaming.isConnected, false);
  assert.equal(
    f.seen.some((v) => v.type === "commit"),
    false
  );
});

test("session schema pins destination and rejects malformed or reusable credentials", () => {
  for (const update of [
    { baseUrl: "https://attacker.test" },
    { websocketUrl: "wss://attacker.test" },
    { clientToken: "token with spaces" },
    { singleUse: false },
    { expiresIn: 3600 },
    { protocol: "other" },
    { model: "other" },
    { clientToken: null },
  ])
    assert.throws(() => validateSession({ ...session(), ...update }), /Invalid/);
  assert.deepEqual(validateSession(session()), {
    baseUrl: ORUKEET_BASE_URL,
    clientToken: session().clientToken,
  });
});

test("invalid backend destination is rejected before any WebSocket is constructed", async (t) => {
  const f = await fixture(t, async () =>
    Response.json({ ...session(), baseUrl: "https://attacker.test" })
  );
  await assert.rejects(connectManagedOrukeet(f.options), /Invalid Orukeet cloud session/);
  assert.equal(f.sockets.length, 0);
});
