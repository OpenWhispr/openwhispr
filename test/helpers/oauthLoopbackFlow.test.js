const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
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

function startFlow(handleCallback = async () => ({ ok: true })) {
  const { runOAuthLoopbackFlow } = loadLoopback();
  let redirectUri;
  let state;
  const flow = runOAuthLoopbackFlow({
    errorParam: "gcal_error",
    buildAuthUrl: (uri, flowState) => {
      redirectUri = uri;
      state = flowState;
      return "https://example.test/auth";
    },
    handleCallback,
  });
  return { flow, getRedirectUri: () => redirectUri, getState: () => state };
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
    const request = http.get({ hostname, port, path }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
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
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    releaseHandleCallback,
  } = startBlockedFlow();
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
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    releaseHandleCallback,
  } = startBlockedFlow();
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
