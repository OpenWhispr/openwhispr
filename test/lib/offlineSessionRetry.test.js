const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("./rendererTestHarness");

const SESSION_URL = "https://auth.openwhispr.test/api/auth/get-session";

function installWindow(tokenState) {
  const previousWindow = global.window;
  const focusListeners = new Set();
  global.window = {
    location: { origin: "https://desktop.openwhispr.test", search: "?panel=true" },
    addEventListener: (type, listener) => {
      if (type === "focus") focusListeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "focus") focusListeners.delete(listener);
    },
    electronAPI: {
      onAuthTokenStateChanged: () => () => {},
      authGetTokenState: async () => ({ ...tokenState }),
      getActiveAccountScope: async () => ({
        accountId: "user-a",
        authGeneration: tokenState.generation,
      }),
    },
  };
  return {
    focus: () => focusListeners.forEach((listener) => listener()),
    focusListenerCount: () => focusListeners.size,
    restore: () => {
      global.window = previousWindow;
    },
  };
}

const sessionRequest = (generation) => ({
  url: SESSION_URL,
  headers: new Headers({ Authorization: "Bearer token-a" }),
  openWhisprAuthGeneration: generation,
});

async function createValidatedSession(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = installWindow({ token: "token-a", generation: 4 });
  t.after(browser.restore);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-offline-retry-" });
  const authContext = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const { authClient } = await vite.ssrLoadModule("/lib/auth.ts");
  const session = authClient.$store.atoms.session;
  const answer = () =>
    new Response(JSON.stringify({ user: { id: "user-a" }, session: { id: "session-a" } }), {
      headers: { "Content-Type": "application/json" },
    });
  t.mock.method(globalThis, "fetch", async () => answer());
  await session.value.refetch();
  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), true);
  return { browser, authContext, authClient, session, answer };
}

test("an offline account asks for the session again until the server answers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = installWindow({ token: "token-a", generation: 3 });
  t.after(browser.restore);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-offline-retry-" });
  const authContext = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const { authClient } = await vite.ssrLoadModule("/lib/auth.ts");
  authContext.resetAuthRequestContextForTests();
  const signals = [];
  t.after(authClient.$store.atoms.$sessionSignal.listen(() => signals.push("$sessionSignal")));

  await authContext.handleAuthRequestError({
    request: sessionRequest(3),
    response: new Response("", { status: 503 }),
  });
  assert.deepEqual(authContext.getOfflineAccount(), { userId: "user-a", generation: 3 });

  browser.focus();
  t.mock.timers.tick(60_000);
  assert.deepEqual(signals, ["$sessionSignal", "$sessionSignal"]);

  // A request still in flight is left to finish.
  const session = authClient.$store.atoms.session;
  const idle = session.value;
  session.set({ ...idle, isRefetching: true });
  browser.focus();
  t.mock.timers.tick(60_000);
  assert.equal(signals.length, 2);
  session.set(idle);

  // The account stays presented until reconciliation validates the answer,
  // which ends the retries.
  await authContext.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(3),
  });
  assert.equal(authContext.commitValidatedAuthContext(3, "user-a"), true);
  assert.equal(authContext.getOfflineAccount(), null);
  assert.equal(browser.focusListenerCount(), 0);
  browser.focus();
  t.mock.timers.tick(60_000);
  assert.equal(signals.length, 2);
});

test("a session whose refetch failed asks again until it validates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = installWindow({ token: "token-a", generation: 4 });
  t.after(browser.restore);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-offline-retry-" });
  const authContext = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  const { authClient } = await vite.ssrLoadModule("/lib/auth.ts");
  authContext.resetAuthRequestContextForTests();
  const signals = [];
  t.after(authClient.$store.atoms.$sessionSignal.listen(() => signals.push("$sessionSignal")));

  await authContext.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(4),
  });
  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), true);
  browser.focus();
  assert.deepEqual(signals, []);

  // A refetch threw: the binding stays, the validated lease is gone.
  authContext.invalidateValidatedAuthContext();
  browser.focus();
  assert.deepEqual(signals, ["$sessionSignal"]);

  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), true);
  assert.equal(browser.focusListenerCount(), 0);
});

test("an interrupted session body stays fenced until recovery and cancellation keeps validation", async (t) => {
  const { browser, authContext, authClient, session, answer } = await createValidatedSession(t);

  let body;
  let headersSent;
  const headers = new Promise((resolve) => (headersSent = resolve));
  const pendingBody = async (_input, { signal }) => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          body = controller;
          controller.enqueue(new TextEncoder().encode('{"user":'));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
    headersSent();
    return response;
  };
  globalThis.fetch = pendingBody;
  const interrupted = session.value.refetch();
  await headers;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authContext.getValidatedAuthGeneration(), 4);
  body.error(new TypeError("session body disconnected"));
  await interrupted;

  assert.equal(session.value.error?.message, "session body disconnected");
  assert.equal(authContext.getBoundSessionGeneration("user-a"), 4);
  assert.equal(authContext.getValidatedAuthGeneration(), null);
  const signals = [];
  t.after(authClient.$store.atoms.$sessionSignal.listen(() => signals.push("retry")));
  browser.focus();
  t.mock.timers.tick(60_000);
  assert.deepEqual(signals, ["retry", "retry"]);

  let finish;
  globalThis.fetch = () => new Promise((resolve) => (finish = resolve));
  const recovery = session.value.refetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.value.error, null);
  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), false);
  finish(answer());
  await recovery;

  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), true);
  assert.equal(authContext.getValidatedAuthGeneration(), 4);
  assert.equal(browser.focusListenerCount(), 0);

  // Better Auth aborts the old body when a newer refetch starts.
  const cancelledHeaders = new Promise((resolve) => (headersSent = resolve));
  globalThis.fetch = pendingBody;
  const cancelled = session.value.refetch();
  await cancelledHeaders;
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.fetch = async () => answer();
  await Promise.all([cancelled, session.value.refetch()]);

  assert.equal(session.value.error, null);
  assert.equal(authContext.getValidatedAuthGeneration(), 4);
  assert.equal(browser.focusListenerCount(), 0);
});

test("a cancelled server-error binding read cannot clear a newer successful session", async (t) => {
  const { browser, authContext, session, answer } = await createValidatedSession(t);

  let releaseScope;
  let scopeRequested;
  const scopeRead = new Promise((resolve) => (scopeRequested = resolve));
  t.mock.method(globalThis.window.electronAPI, "getActiveAccountScope", () => {
    scopeRequested();
    return new Promise((resolve) => (releaseScope = resolve));
  });
  let failedSignal;
  globalThis.fetch = async (_input, { signal }) => {
    failedSignal = signal;
    return new Response("{}", { status: 503 });
  };
  const failedRefetch = session.value.refetch();
  await scopeRead;

  globalThis.fetch = async () => answer();
  await session.value.refetch();
  assert.equal(failedSignal.aborted, true);
  assert.equal(authContext.commitValidatedAuthContext(4, "user-a"), true);

  releaseScope({ accountId: "user-a", authGeneration: 4 });
  await failedRefetch;

  assert.equal(session.value.data.user.id, "user-a");
  assert.equal(session.value.error, null);
  assert.equal(authContext.getBoundSessionGeneration("user-a"), 4);
  assert.equal(authContext.getValidatedAuthGeneration(), 4);
  assert.equal(authContext.getOfflineAccount(), null);
  assert.equal(browser.focusListenerCount(), 0);
});

test("an interrupted 401 body preserves the rejection and clears the saved account", async (t) => {
  const { browser, authContext, session } = await createValidatedSession(t);
  const profileKey = "openwhispr:accountProfile";
  const stored = new Map([[profileKey, JSON.stringify({ id: "user-a", validatedAt: Date.now() })]]);
  globalThis.window.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    removeItem: (key) => stored.delete(key),
  };
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message":'));
          setImmediate(() => controller.error(new TypeError("401 body disconnected")));
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  await session.value.refetch();

  assert.equal(authContext.getBoundSessionGeneration("user-a"), null);
  assert.equal(authContext.getValidatedAuthGeneration(), null);
  assert.equal(authContext.getAuthRequestContextSnapshot().sessionRejectedGeneration, 4);
  assert.equal(stored.has(profileKey), false);
  assert.equal(browser.focusListenerCount(), 0);

  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  await session.value.refetch();
  assert.equal(authContext.getOfflineAccount(), null);
});
