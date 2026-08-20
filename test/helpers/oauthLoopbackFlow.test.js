const test = require("node:test");
const assert = require("node:assert/strict");
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

async function waitForListen(getRedirectUri) {
  for (let i = 0; i < 50; i++) {
    if (getRedirectUri()) return getRedirectUri();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("loopback server did not start");
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
