const test = require("node:test");
const assert = require("node:assert/strict");
const { NOW, FIXTURES, fakeGithubFetch, json, oauthError } = require("./githubFixtures");

const load = () => import("../../../src/helpers/connectors/githubDeviceFlow.js");

const CLIENT_ID = "Iv1.test";
const EXPIRES_AT = NOW + 900 * 1000;

// What githubApi's accessToken returns for GitHub's HTTP-200 OAuth errors.
const refusal = (errorCode, extra = {}) => ({
  ok: false,
  outcome: "failed",
  errorCode,
  refused: true,
  ...extra,
});
const PENDING = refusal("authorization_pending");
const SLOW_DOWN = refusal("slow_down");
const GRANTED = { ok: true, data: FIXTURES.token };

// A scripted githubApi: each accessToken call answers with the next reply,
// and the last repeats. A reply may be a function of the call's options.
function scriptedApi({ device = { ok: true, data: FIXTURES.deviceCode }, token = [PENDING] } = {}) {
  const calls = { deviceCode: [], accessToken: [] };
  const queue = [...token];
  return {
    calls,
    deviceCode: async (params, options = {}) => {
      calls.deviceCode.push({ params, hasSignal: Boolean(options.signal) });
      return device;
    },
    accessToken: async (params, options = {}) => {
      calls.accessToken.push(params);
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      return typeof reply === "function" ? reply(options) : reply;
    },
  };
}

// A clock that moves only when the flow sleeps.
function manualClock(start = NOW) {
  let time = start;
  const sleeps = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

async function poll(token, overrides = {}) {
  const { createDeviceFlow } = await load();
  const api = scriptedApi({ token });
  const clock = manualClock();
  const flow = createDeviceFlow({ api, sleep: clock.sleep, now: clock.now });
  const outcome = flow
    .pollForToken({
      clientId: CLIENT_ID,
      deviceCode: "dc-test-1",
      intervalMs: 5000,
      expiresAt: EXPIRES_AT,
      ...overrides,
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  return { ...(await outcome), api, clock };
}

// Lets resolved promises run without moving the (fake) clock.
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("startDeviceAuthorization asks for a code with the client id only", async () => {
  const { createDeviceFlow } = await load();
  const api = scriptedApi();
  const flow = createDeviceFlow({ api, now: () => NOW });

  const started = await flow.startDeviceAuthorization({ clientId: CLIENT_ID });

  assert.deepEqual(started, {
    deviceCode: "dc-test-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresAt: NOW + 900 * 1000,
    intervalMs: 5000,
  });
  assert.deepEqual(api.calls.deviceCode, [{ params: { client_id: CLIENT_ID }, hasSignal: false }]);
});

test("startDeviceAuthorization refuses a disabled flow, a refused request and a bad reply", async () => {
  const { createDeviceFlow } = await load();
  const cases = [
    [refusal("device_flow_disabled"), "device_flow_disabled"],
    [refusal("incorrect_client_credentials"), "token_exchange_failed"],
    [{ ok: false, outcome: "failed", errorCode: "http_404" }, "token_exchange_failed"],
    [{ ok: false, outcome: "unknown", errorCode: "bad_response" }, "token_exchange_failed"],
    [{ ok: true, data: { ...FIXTURES.deviceCode, user_code: "" } }, "token_exchange_failed"],
    [{ ok: true, data: { ...FIXTURES.deviceCode, device_code: 7 } }, "token_exchange_failed"],
    [
      {
        ok: true,
        data: { ...FIXTURES.deviceCode, verification_uri: "https://evil.example/login/device" },
      },
      "token_exchange_failed",
    ],
  ];
  for (const [device, code] of cases) {
    const flow = createDeviceFlow({ api: scriptedApi({ device }), now: () => NOW });
    await assert.rejects(flow.startDeviceAuthorization({ clientId: CLIENT_ID }), { code });
  }

  const api = scriptedApi();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createDeviceFlow({ api }).startDeviceAuthorization({
      clientId: CLIENT_ID,
      signal: controller.signal,
    }),
    { code: "oauth_cancelled" }
  );
  assert.equal(api.calls.deviceCode.length, 0);
});

test("startDeviceAuthorization reports no answer or a throttle apart from a refusal", async () => {
  const { createDeviceFlow } = await load();
  const { createGithubApi } = await import("../../../src/helpers/connectors/githubApi.js");
  const offline = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), {
    code: "ENOTFOUND",
  });
  const cases = [
    [{ throw: offline }, "network"],
    [{ throw: Object.assign(new Error("timed out"), { name: "TimeoutError" }) }, "network"],
    [json({ message: "Bad gateway" }, 502), "network"],
    [oauthError("server_error"), "network"],
    [json({ message: "Request timeout" }, 408), "network"],
    [json({ message: "Too many requests" }, 429), "rate_limited"],
    [json({ error: "slow_down" }, 429), "rate_limited"],
    [json({ message: "Not found" }, 404), "token_exchange_failed"],
    [oauthError("incorrect_client_credentials"), "token_exchange_failed"],
  ];
  for (const [reply, code] of cases) {
    const github = fakeGithubFetch({ "POST /login/device/code": [reply] });
    const flow = createDeviceFlow({
      api: createGithubApi({ fetchImpl: github.fetchImpl }),
      now: () => NOW,
    });
    await assert.rejects(flow.startDeviceAuthorization({ clientId: CLIENT_ID }), { code });
  }
});

test("startDeviceAuthorization falls back to GitHub's default interval and expiry", async () => {
  const { createDeviceFlow } = await load();
  const { interval, expires_in, ...bare } = FIXTURES.deviceCode;
  assert.equal(interval, 5);
  assert.equal(expires_in, 900);
  const flow = createDeviceFlow({
    api: scriptedApi({ device: { ok: true, data: bare } }),
    now: () => NOW,
  });
  const started = await flow.startDeviceAuthorization({ clientId: CLIENT_ID });
  assert.equal(started.intervalMs, 5000);
  assert.equal(started.expiresAt, NOW + 900 * 1000);
});

test("pending, pending, then a token: waits the interval before every poll, no secret", async () => {
  const { DEVICE_GRANT_TYPE } = await load();
  const { value, api, clock } = await poll([PENDING, PENDING, GRANTED]);

  assert.deepEqual(value, { ok: true, token: FIXTURES.token });
  assert.deepEqual(clock.sleeps, [5000, 5000, 5000]);
  assert.equal(api.calls.accessToken.length, 3);
  for (const params of api.calls.accessToken) {
    assert.deepEqual(params, {
      client_id: CLIENT_ID,
      device_code: "dc-test-1",
      grant_type: DEVICE_GRANT_TYPE,
    });
  }
  assert.equal(DEVICE_GRANT_TYPE, "urn:ietf:params:oauth:grant-type:device_code");
});

test("slow_down adds 5 s each time, or takes GitHub's longer interval", async () => {
  const stepped = await poll([SLOW_DOWN, SLOW_DOWN, GRANTED]);
  assert.deepEqual(stepped.clock.sleeps, [5000, 10000, 15000]);
  assert.equal(stepped.value.ok, true);

  const told = await poll([refusal("slow_down", { intervalMs: 20000 }), PENDING, GRANTED]);
  assert.deepEqual(told.clock.sleeps, [5000, 20000, 20000]);

  // An interval shorter than "5 s more" never speeds polling up.
  const shorter = await poll([refusal("slow_down", { intervalMs: 6000 }), GRANTED]);
  assert.deepEqual(shorter.clock.sleeps, [5000, 10000]);
});

test("expired_token, or a passed expiresAt, is code_expired with no request after expiry", async () => {
  const expired = await poll([PENDING, refusal("expired_token")]);
  assert.equal(expired.error.code, "code_expired");
  assert.equal(expired.api.calls.accessToken.length, 2);

  // 12 s left at 5 s a poll: polls at +5 s and +10 s, then sleeps the last
  // 2 s and stops without asking again.
  const running = await poll([PENDING], { expiresAt: NOW + 12000 });
  assert.equal(running.error.code, "code_expired");
  assert.deepEqual(running.clock.sleeps, [5000, 5000, 2000]);
  assert.equal(running.api.calls.accessToken.length, 2);

  const already = await poll([GRANTED], { expiresAt: NOW });
  assert.equal(already.error.code, "code_expired");
  assert.equal(already.api.calls.accessToken.length, 0);
});

test("access_denied is oauth_denied; a disabled flow and other refusals end the poll", async () => {
  const cases = [
    [refusal("access_denied"), "oauth_denied"],
    [refusal("device_flow_disabled"), "device_flow_disabled"],
    [refusal("incorrect_device_code"), "token_exchange_failed"],
    [refusal("unsupported_grant_type"), "token_exchange_failed"],
    [{ ok: false, outcome: "failed", errorCode: "http_404" }, "token_exchange_failed"],
    [{ ok: true, data: { token_type: "bearer" } }, "token_exchange_failed"],
  ];
  for (const [reply, code] of cases) {
    const { error, api } = await poll([PENDING, reply]);
    assert.equal(error?.code, code, JSON.stringify(reply));
    assert.equal(api.calls.accessToken.length, 2, "stops at once");
  }
});

test("a poll with no answer is asked again at the interval until the code expires", async () => {
  const offline = { ok: false, outcome: "failed", errorCode: "ENOTFOUND" };
  const outage = { ok: false, outcome: "unknown", errorCode: "http_502" };
  const timeout = { ok: false, outcome: "unknown", errorCode: "timeout" };
  const requestTimeout = { ok: false, outcome: "failed", errorCode: "http_408" };
  const tryLater = { ok: false, outcome: "failed", errorCode: "temporarily_unavailable" };

  // A minute offline while the user types the code on a phone.
  const blip = [...Array(12).fill(offline), outage, timeout, requestTimeout, tryLater];
  const recovered = await poll([...blip, PENDING, GRANTED]);
  assert.deepEqual(recovered.value, { ok: true, token: FIXTURES.token });
  assert.equal(recovered.api.calls.accessToken.length, blip.length + 2);
  assert.ok(
    recovered.clock.sleeps.every((ms) => ms === 5000),
    "never faster than the interval"
  );

  // Offline for the code's whole life: a poll every 5 s until it expires,
  // and none at the moment it does.
  const gone = await poll([offline]);
  assert.equal(gone.error.code, "code_expired");
  assert.equal(gone.api.calls.accessToken.length, 900 / 5 - 1);
});

test("a bare 429 on a poll slows it down like slow_down, and doesn't end it", async () => {
  const throttled = { ok: false, outcome: "failed", errorCode: "http_429" };
  const { value, clock } = await poll([throttled, throttled, PENDING, GRANTED]);
  assert.deepEqual(value, { ok: true, token: FIXTURES.token });
  assert.deepEqual(clock.sleeps, [5000, 10000, 15000, 15000]);
});

test("the interval is honoured on real timers: nothing is asked early (fake timers)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createDeviceFlow } = await load();
  const api = scriptedApi({ token: [PENDING, SLOW_DOWN, GRANTED] });
  const flow = createDeviceFlow({ api, now: () => NOW });
  const polling = flow.pollForToken({
    clientId: CLIENT_ID,
    deviceCode: "dc-test-1",
    intervalMs: 5000,
    expiresAt: EXPIRES_AT,
  });
  const polls = () => api.calls.accessToken.length;

  await settle();
  assert.equal(polls(), 0, "the first poll waits a full interval");
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(polls(), 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(polls(), 1);

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(polls(), 2, "then slow_down");

  t.mock.timers.tick(9999);
  await settle();
  assert.equal(polls(), 2, "slow_down waits 10 s now");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(polls(), 3);

  assert.deepEqual(await polling, { ok: true, token: FIXTURES.token });
});

test("an abort mid-wait is oauth_cancelled at once, with no request after it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createDeviceFlow } = await load();
  const api = scriptedApi({ token: [PENDING] });
  const controller = new AbortController();
  const polling = createDeviceFlow({ api, now: () => NOW }).pollForToken({
    clientId: CLIENT_ID,
    deviceCode: "dc-test-1",
    intervalMs: 5000,
    expiresAt: EXPIRES_AT,
    signal: controller.signal,
  });

  t.mock.timers.tick(5000);
  await settle();
  assert.equal(api.calls.accessToken.length, 1);
  t.mock.timers.tick(2000);
  controller.abort();

  // Settles without the clock moving past the 5 s interval.
  await assert.rejects(polling, { code: "oauth_cancelled" });
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(api.calls.accessToken.length, 1);
});

test("an abort while a poll is in flight is oauth_cancelled, not a retry", async () => {
  const controller = new AbortController();
  const inFlight = (options) =>
    new Promise((resolve) => {
      options.signal.addEventListener("abort", () =>
        resolve({ ok: false, outcome: "unknown", errorCode: "network_error" })
      );
      setTimeout(() => controller.abort(), 0);
    });
  const { error, api } = await poll([inFlight, GRANTED], { signal: controller.signal });
  assert.equal(error.code, "oauth_cancelled");
  assert.equal(api.calls.accessToken.length, 1);

  // Even a token that lands after the abort is not used.
  const late = new AbortController();
  const lateToken = async () => {
    late.abort();
    return GRANTED;
  };
  const cancelled = await poll([lateToken], { signal: late.signal });
  assert.equal(cancelled.error.code, "oauth_cancelled");
});

test("end to end over githubApi: a throttle or a try-later answer keeps the poll going", async () => {
  const { createDeviceFlow } = await load();
  const { createGithubApi } = await import("../../../src/helpers/connectors/githubApi.js");
  const github = fakeGithubFetch({
    "POST /login/oauth/access_token": [
      json({ message: "Too many requests" }, 429),
      oauthError("temporarily_unavailable"),
      json({ error: "incorrect_device_code" }, 429),
      json(FIXTURES.token),
    ],
  });
  const clock = manualClock();
  const flow = createDeviceFlow({
    api: createGithubApi({ fetchImpl: github.fetchImpl }),
    sleep: clock.sleep,
    now: clock.now,
  });

  const result = await flow.pollForToken({
    clientId: CLIENT_ID,
    deviceCode: "dc-test-1",
    intervalMs: 5000,
    expiresAt: EXPIRES_AT,
  });

  assert.deepEqual(result, { ok: true, token: FIXTURES.token });
  assert.deepEqual(clock.sleeps, [5000, 10000, 10000, 10000]);
});

test("end to end over githubApi: GitHub's HTTP-200 errors drive the poll", async () => {
  const { createDeviceFlow } = await load();
  const { createGithubApi } = await import("../../../src/helpers/connectors/githubApi.js");
  const github = fakeGithubFetch({
    "POST /login/device/code": [json(FIXTURES.deviceCode)],
    "POST /login/oauth/access_token": [
      oauthError("authorization_pending"),
      oauthError("slow_down", { interval: 10 }),
      json(FIXTURES.token),
    ],
  });
  const clock = manualClock();
  const flow = createDeviceFlow({
    api: createGithubApi({ fetchImpl: github.fetchImpl }),
    sleep: clock.sleep,
    now: clock.now,
  });

  const started = await flow.startDeviceAuthorization({ clientId: CLIENT_ID });
  const result = await flow.pollForToken({ clientId: CLIENT_ID, ...started });

  assert.deepEqual(result, { ok: true, token: FIXTURES.token });
  assert.deepEqual(clock.sleeps, [5000, 5000, 10000]);
  assert.ok(github.calls.every((call) => call.origin === "https://github.com"));
  assert.ok(github.calls.every((call) => !("client_secret" in (call.form ?? {}))));

  const denied = createDeviceFlow({
    api: createGithubApi({
      fetchImpl: fakeGithubFetch({
        "POST /login/oauth/access_token": [oauthError("access_denied")],
      }).fetchImpl,
    }),
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    denied.pollForToken({
      clientId: CLIENT_ID,
      deviceCode: "dc-test-1",
      intervalMs: 5000,
      expiresAt: clock.now() + 900000,
    }),
    { code: "oauth_denied" }
  );
});
