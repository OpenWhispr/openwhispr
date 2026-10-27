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
