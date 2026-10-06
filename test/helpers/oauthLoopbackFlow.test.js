const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const Module = require("node:module");

const loopbackModulePath = require.resolve("../../src/helpers/oauthLoopbackFlow.js");
const originalLoad = Module._load;

function loadLoopback() {
  delete require.cache[loopbackModulePath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(loopbackModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function startFlow(handleCallback = async () => ({ ok: true }), options = {}) {
  const { runOAuthLoopbackFlow } = loadLoopback();
  let redirectUri;
  let state;
  let authUrlCalls = 0;
  let server;
  const originalCreateServer = http.createServer;
  http.createServer = (...args) => {
    server = originalCreateServer(...args);
    return server;
  };

  try {
    const flow = runOAuthLoopbackFlow({
      errorParam: "gcal_error",
      ...options,
      buildAuthUrl: (uri, flowState) => {
        redirectUri = uri;
        state = flowState;
        authUrlCalls += 1;
        return "https://example.test/auth";
      },
      handleCallback,
    });
    return {
      flow,
      server,
      getRedirectUri: () => redirectUri,
      getState: () => state,
      getAuthUrlCalls: () => authUrlCalls,
    };
  } finally {
    http.createServer = originalCreateServer;
  }
}

function startBlockedFlow() {
  let callbackCount = 0;
  let releaseHandleCallback;
  let markCallbackStarted;
  const callbackStarted = new Promise((resolve) => {
    markCallbackStarted = resolve;
  });
  const startedFlow = startFlow(async (code) => {
    callbackCount += 1;
    if (callbackCount === 1) {
      markCallbackStarted();
      await new Promise((resolve) => {
        releaseHandleCallback = resolve;
      });
    }
    return { code };
  });

  return {
    ...startedFlow,
    callbackStarted,
    getCallbackCount: () => callbackCount,
    releaseHandleCallback: () => releaseHandleCallback?.(),
  };
}

function startFlowWithControlledTimeout(handleCallback) {
  const originalSetTimeout = global.setTimeout;
  let runFlowTimeout;

  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 120000) {
      runFlowTimeout = () => callback(...args);
      return originalSetTimeout(() => {}, 0);
    }
    return originalSetTimeout(callback, delay, ...args);
  };

  try {
    const startedFlow = startFlow(handleCallback);
    return {
      ...startedFlow,
      triggerTimeout: () => {
        if (!runFlowTimeout) throw new Error("OAuth timeout was not scheduled");
        runFlowTimeout();
      },
    };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

async function waitForListen(getRedirectUri) {
  for (let i = 0; i < 50; i++) {
    if (getRedirectUri()) return getRedirectUri();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("loopback server did not start");
}

function requestPath(redirectUri, path) {
  const { hostname, port } = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname, port, path, agent: false, headers: { Connection: "close" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }
    );
    request.on("error", reject);
  });
}

async function parkPartialRequest(redirectUri, server) {
  const { hostname, port } = new URL(redirectUri);
  let response = "";
  let responseStatus;
  let responseSettled = false;
  let resolveStatus;
  let rejectStatus;
  const status = new Promise((resolve, reject) => {
    resolveStatus = resolve;
    rejectStatus = reject;
  });
  const requestStarted = new Promise((resolve) => {
    server.once("connection", (acceptedSocket) => {
      acceptedSocket.once("data", resolve);
    });
  });
  const socket = net.createConnection({ host: hostname, port });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    response += chunk;
    const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
    if (match) {
      responseStatus = Number(match[1]);
    }
  });
  socket.on("end", () => {
    if (responseStatus && !responseSettled) {
      responseSettled = true;
      resolveStatus(responseStatus);
    }
  });
  socket.on("error", (error) => {
    if (!responseSettled) {
      responseSettled = true;
      rejectStatus(error);
    }
  });
  socket.on("close", () => {
    if (!responseSettled) {
      responseSettled = true;
      rejectStatus(new Error("parked request closed without a response"));
    }
  });

  await new Promise((resolve, reject) => {
    const handleConnect = () => {
      socket.off("error", handleError);
      resolve();
    };
    const handleError = (error) => {
      socket.off("connect", handleConnect);
      reject(error);
    };
    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
  socket.write("GET /");
  await requestStarted;

  return {
    complete: (path) => {
      socket.end(`${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`);
      return status;
    },
    destroy: () => socket.destroy(),
  };
}

test("a callback with a code and the wrong state rejects immediately", async () => {
  const { flow, getRedirectUri } = startFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const started = Date.now();
  const rejected = assert.rejects(flow, /OAuth state mismatch/);

  const response = await fetch(`${redirectUri}/?code=stolen&state=wrong`, {
    redirect: "manual",
  });
  assert.equal(response.status, 400);

  await rejected;
  assert.ok(Date.now() - started < 5000, "must not wait for the 120s timeout");
});

test("a request with no code leaves the flow running until a real callback", async () => {
  const { flow, getRedirectUri, getState } = startFlow(async (code) => ({ code }));
  const redirectUri = await waitForListen(getRedirectUri);

  const stray = await fetch(`${redirectUri}/favicon.ico`, { redirect: "manual" });
  assert.equal(stray.status, 400);

  const stillPending = await Promise.race([
    flow.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
  ]);
  assert.equal(stillPending, "pending");

  const success = await fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  assert.equal(success.status, 302);
  assert.deepEqual(await flow, { code: "ok" });
});

test("a provider error query still fails the flow immediately", async () => {
  const { flow, getRedirectUri } = startFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const rejected = assert.rejects(flow, /OAuth error: access_denied/);

  const response = await fetch(`${redirectUri}/?error=access_denied`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  await rejected;
});

test("a late state mismatch cannot reject a valid callback already in progress", async () => {
  const { flow, getRedirectUri, getState, callbackStarted, releaseHandleCallback } =
    startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    () => "resolved",
    (error) => `rejected: ${error.message}`
  );

  const validResponsePromise = fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let mismatchResponse;
  let outcomeBeforeRelease;
  try {
    mismatchResponse = await fetch(`${redirectUri}/?code=stale&state=wrong`, {
      redirect: "manual",
    });
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const validResponse = await validResponsePromise;
  assert.equal(mismatchResponse.status, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(validResponse.status, 302);
  assert.equal(await flowOutcome, "resolved");
});

test("a late malformed request cannot reject a valid callback already in progress", async () => {
  const { flow, getRedirectUri, getState, callbackStarted, releaseHandleCallback } =
    startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    () => "resolved",
    (error) => `rejected: ${error.message}`
  );

  const validResponsePromise = fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let malformedStatus;
  let outcomeBeforeRelease;
  try {
    malformedStatus = await requestPath(redirectUri, "//[");
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const validResponse = await validResponsePromise;
  assert.equal(malformedStatus, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(validResponse.status, 302);
  assert.equal(await flowOutcome, "resolved");
});

test("a second valid callback cannot start another token exchange", async () => {
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    getCallbackCount,
    releaseHandleCallback,
  } = startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    (result) => ({ status: "resolved", result }),
    (error) => ({ status: "rejected", error: error.message })
  );

  const firstResponsePromise = fetch(`${redirectUri}/?code=first&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let duplicateResponse;
  let outcomeBeforeRelease;
  try {
    duplicateResponse = await fetch(`${redirectUri}/?code=duplicate&state=${getState()}`, {
      redirect: "manual",
    });
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const firstResponse = await firstResponsePromise;
  assert.equal(duplicateResponse.status, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(getCallbackCount(), 1);
  assert.equal(firstResponse.status, 302);
  assert.deepEqual(await flowOutcome, {
    status: "resolved",
    result: { code: "first" },
  });
});

test("an accepted callback cannot run after a malformed request rejects the flow", async () => {
  let callbackCount = 0;
  const { flow, server, getRedirectUri, getState } = startFlow(async () => {
    callbackCount += 1;
    return { ok: true };
  });
  const redirectUri = await waitForListen(getRedirectUri);
  const parkedRequest = await parkPartialRequest(redirectUri, server);
  const rejected = assert.rejects(flow, /Invalid URL/);

  try {
    assert.equal(await requestPath(redirectUri, "//["), 302);
    await rejected;

    const lateStatus = await parkedRequest.complete(`?code=late&state=${getState()}`);
    assert.equal(lateStatus, 400);
    assert.equal(callbackCount, 0);
  } finally {
    parkedRequest.destroy();
  }
});

test("an accepted callback cannot run after the flow times out", async () => {
  let callbackCount = 0;
  const { flow, server, getRedirectUri, getState, triggerTimeout } = startFlowWithControlledTimeout(
    async () => {
      callbackCount += 1;
      return { ok: true };
    }
  );
  const redirectUri = await waitForListen(getRedirectUri);
  const parkedRequest = await parkPartialRequest(redirectUri, server);
  const rejected = assert.rejects(flow, /OAuth flow timed out/);

  try {
    triggerTimeout();
    await rejected;

    const lateStatus = await parkedRequest.complete(`?code=late&state=${getState()}`);
    assert.equal(lateStatus, 400);
    assert.equal(callbackCount, 0);
  } finally {
    parkedRequest.destroy();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function getLocal(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

test("a fixed port, redirect host and path shape the redirect uri both times", async () => {
  const port = await freePort();
  const started = startFlow(async (code, redirectUri) => ({ code, redirectUri }), {
    redirectHost: "localhost",
    ports: [port],
    callbackPath: "/slack/callback",
  });
  const redirectUri = await until(started.getRedirectUri);
  assert.equal(redirectUri, `http://localhost:${port}/slack/callback`);

  await getLocal(`http://127.0.0.1:${port}/slack/callback?code=c1&state=${started.getState()}`);

  assert.deepEqual(await started.flow, {
    code: "c1",
    redirectUri: `http://localhost:${port}/slack/callback`,
  });
});

test("a busy fixed port falls through to the next with one browser launch; all busy rejects ports_busy", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busy = blocker.address().port;
  const free = await freePort();
  try {
    const started = startFlow(async (code) => ({ code }), { ports: [busy, free] });
    assert.equal(await until(started.getRedirectUri), `http://127.0.0.1:${free}`);
    await getLocal(`http://127.0.0.1:${free}/?code=c2&state=${started.getState()}`);
    assert.deepEqual(await started.flow, { code: "c2" });
    assert.equal(started.getAuthUrlCalls(), 1, "exactly one browser launch");

    const allBusy = startFlow(async () => ({}), { ports: [busy] });
    await assert.rejects(allBusy.flow, (error) => error.code === "ports_busy");
    assert.equal(allBusy.getAuthUrlCalls(), 0);
  } finally {
    blocker.close();
  }
});

test("a local result page replaces the hosted desktop-callback redirect", async () => {
  const started = startFlow(async () => ({ ok: true }), {
    renderResultPage: ({ ok }) => `<p>${ok ? "connected" : "failed"}</p>`,
  });
  const redirectUri = await until(started.getRedirectUri);

  const response = await getLocal(`${redirectUri}/?code=c3&state=${started.getState()}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.location, undefined);
  assert.equal(response.body, "<p>connected</p>");
  await started.flow;
});

test("a denied consent rejects with oauth_denied and shows the failure page", async () => {
  const started = startFlow(async () => ({}), {
    renderResultPage: ({ ok }) => (ok ? "yes" : "no"),
  });
  const redirectUri = await until(started.getRedirectUri);
  const outcome = started.flow.catch((error) => error);

  const response = await getLocal(
    `${redirectUri}/?error=access_denied&state=${started.getState()}`
  );

  assert.equal(response.body, "no");
  const error = await outcome;
  assert.equal(error.code, "oauth_denied");
  assert.equal(error.providerError, "access_denied");
});

const RELAY = "https://openwhispr.com/auth/slack/callback";

test("behind a relay, the public redirect URI goes to the provider and the exchange, and state carries the port", async () => {
  const started = startFlow(async (code, redirectUri) => ({ code, redirectUri }), {
    publicRedirectUri: RELAY,
    callbackPath: "/slack/callback",
  });
  assert.equal(await until(started.getRedirectUri), RELAY);
  const port = started.server.address().port;
  assert.match(started.getState(), new RegExp(`^v1\\.${port}\\.[0-9a-f]{64}$`));

  // What the relay does with Slack's redirect.
  await getLocal(`http://127.0.0.1:${port}/slack/callback?code=c4&state=${started.getState()}`);

  assert.deepEqual(await started.flow, { code: "c4", redirectUri: RELAY });
  assert.equal(started.getAuthUrlCalls(), 1);
});

test("behind a relay, the right port with another nonce is a state mismatch", async () => {
  const started = startFlow(async () => ({ ok: true }), { publicRedirectUri: RELAY });
  await until(started.getRedirectUri);
  const port = started.server.address().port;
  const outcome = started.flow.catch((error) => error);

  await getLocal(`http://127.0.0.1:${port}/?code=c5&state=v1.${port}.${"0".repeat(64)}`);

  assert.equal((await outcome).code, "oauth_state_mismatch");
});

test("without a relay, the state stays a bare nonce", async () => {
  const started = startFlow(async (code) => ({ code }));
  await until(started.getRedirectUri);
  assert.match(started.getState(), /^[0-9a-f]{64}$/);

  await getLocal(`${started.getRedirectUri()}/?code=c6&state=${started.getState()}`);

  assert.deepEqual(await started.flow, { code: "c6" });
});

test("timeoutMs bounds how long the flow waits", { timeout: 5000 }, async () => {
  const started = startFlow(async () => ({}), { timeoutMs: 30 });
  await assert.rejects(started.flow, (error) => error.code === "oauth_timeout");
});

test("an abort closes the server and rejects oauth_cancelled", async () => {
  const controller = new AbortController();
  let callbackCount = 0;
  const started = startFlow(
    async () => {
      callbackCount += 1;
      return {};
    },
    { signal: controller.signal }
  );
  const redirectUri = await until(started.getRedirectUri);
  const outcome = started.flow.catch((error) => error);

  controller.abort();

  assert.equal((await outcome).code, "oauth_cancelled");
  assert.equal(started.server.listening, false);
  await assert.rejects(getLocal(`${redirectUri}/?code=late&state=${started.getState()}`));
  assert.equal(callbackCount, 0);
});

test("a flow whose signal is already aborted never opens the browser", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = startFlow(async () => ({}), { signal: controller.signal });

  await assert.rejects(started.flow, (error) => error.code === "oauth_cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started.getAuthUrlCalls(), 0);
});

test("an abort after the provider answered lets the exchange finish", async () => {
  const controller = new AbortController();
  let release;
  let markStarted;
  const exchangeStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const started = startFlow(
    async (code) => {
      markStarted();
      await new Promise((resolve) => {
        release = resolve;
      });
      return { code };
    },
    { signal: controller.signal }
  );
  const redirectUri = await until(started.getRedirectUri);

  const response = getLocal(`${redirectUri}/?code=c9&state=${started.getState()}`);
  await exchangeStarted;
  controller.abort();
  release();

  // The caller decides what to do with a login it no longer wants; the flow
  // never drops one the provider already issued.
  assert.deepEqual(await started.flow, { code: "c9" });
  assert.equal((await response).status, 302);
});

async function stillWaiting(flow) {
  return Promise.race([
    flow.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
  ]);
}

test("behind a relay, an error without this flow's state is a stray request, not a denial", async () => {
  const started = startFlow(async (code) => ({ code }), { publicRedirectUri: RELAY });
  await until(started.getRedirectUri);
  const port = started.server.address().port;

  const bare = await getLocal(`http://127.0.0.1:${port}/anything?error=access_denied`);
  const otherState = await getLocal(
    `http://127.0.0.1:${port}/?error=access_denied&state=v1.${port}.${"0".repeat(64)}`
  );

  assert.equal(bare.status, 400);
  assert.equal(otherState.status, 400);
  assert.equal(await stillWaiting(started.flow), "pending");
  await getLocal(`http://127.0.0.1:${port}/?code=c7&state=${started.getState()}`);
  assert.deepEqual(await started.flow, { code: "c7" });
});

test("behind a relay, an error with this flow's state still denies", async () => {
  const started = startFlow(async () => ({}), { publicRedirectUri: RELAY });
  await until(started.getRedirectUri);
  const port = started.server.address().port;
  const outcome = started.flow.catch((error) => error);

  await getLocal(`http://127.0.0.1:${port}/?error=access_denied&state=${started.getState()}`);

  assert.equal((await outcome).code, "oauth_denied");
});

test("with a callback path, only that path is a callback", async () => {
  const started = startFlow(async (code) => ({ code }), {
    publicRedirectUri: RELAY,
    callbackPath: "/slack/callback",
  });
  await until(started.getRedirectUri);
  const port = started.server.address().port;
  const state = started.getState();

  const wrongPathCode = await getLocal(`http://127.0.0.1:${port}/other?code=stray&state=${state}`);
  const wrongPathError = await getLocal(
    `http://127.0.0.1:${port}/other?error=access_denied&state=${state}`
  );

  assert.equal(wrongPathCode.status, 400);
  assert.equal(wrongPathError.status, 400);
  assert.equal(await stillWaiting(started.flow), "pending");
  await getLocal(`http://127.0.0.1:${port}/slack/callback?code=c8&state=${state}`);
  assert.deepEqual(await started.flow, { code: "c8" });
});
