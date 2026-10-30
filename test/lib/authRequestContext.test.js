const test = require("node:test");
const assert = require("node:assert/strict");

function installWindow(state) {
  const previousWindow = global.window;
  global.window = {
    // Only the control panel (?panel=true) resolves its own session.
    location: {
      origin: "https://desktop.openwhispr.test",
      search: state.dictationWindow ? "" : "?panel=true",
    },
    localStorage: state.storage,
    electronAPI: {
      authGetTokenState: async () => ({ ...state.current }),
      authSetToken: async (token, expectedGeneration) => {
        if (state.current.generation !== expectedGeneration) {
          return {
            success: false,
            code: "AUTH_CONTEXT_CHANGED",
            ...state.current,
          };
        }
        if (state.current.token !== token) {
          state.current = {
            token,
            generation: state.current.generation + 1,
          };
        }
        state.onSet?.(state.current);
        return { success: true, ...state.current };
      },
      // Main's token-bound binding: names an account only for the bearer it
      // validated, paired with the current credential generation.
      getActiveAccountScope: async () =>
        state.binding && state.current.token === state.binding.token
          ? { accountId: state.binding.accountId, authGeneration: state.current.generation }
          : null,
    },
  };
  return () => {
    global.window = previousWindow;
  };
}

function sessionRequest(generation, token) {
  return {
    url: "https://auth.openwhispr.test/api/auth/get-session",
    headers: new Headers(token ? { Authorization: `Bearer ${token}` } : {}),
    openWhisprAuthGeneration: generation,
  };
}

test("only the exact session user and credential generation can be committed", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = { current: { token: "token-a", generation: 4 } };
  t.after(installWindow(state));

  await auth.handleAuthRequestSuccess({
    data: { user: { id: "user-a" }, session: { id: "session-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(4, "token-a"),
  });

  assert.equal(auth.getBoundSessionGeneration("user-a"), 4);
  assert.equal(auth.getBoundSessionGeneration("user-b"), null);
  assert.equal(auth.commitValidatedAuthContext(4, "user-b"), false);
  assert.equal(auth.commitValidatedAuthContext(4, "user-a"), true);
  assert.equal(auth.getValidatedAuthGeneration(), 4);

  await auth.handleAuthRequestSuccess({
    data: null,
    response: new Response("null", { status: 200 }),
    request: sessionRequest(4, "token-a"),
  });
  assert.equal(auth.getBoundSessionGeneration(null), 4);
  assert.equal(auth.getValidatedAuthGeneration(), null);

  auth.observeAuthTokenStateEvent({ generation: 5, hasToken: true });
  assert.equal(auth.getBoundSessionGeneration("user-a"), null);
  assert.equal(auth.getValidatedAuthGeneration(), null);
});

test("a compare-and-set rotation binds the session response to the new generation", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 1 },
    onSet: (next) => {
      // Main broadcasts before the invoke response resolves.
      auth.observeAuthTokenStateEvent({
        generation: next.generation,
        hasToken: Boolean(next.token),
      });
    },
  };
  t.after(installWindow(state));

  await auth.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", {
      status: 200,
      headers: { "set-auth-token": "token-a-rotated" },
    }),
    request: sessionRequest(1, "token-a"),
  });

  assert.equal(state.current.generation, 2);
  assert.equal(auth.getBoundSessionGeneration("user-a"), 2);
  assert.equal(auth.commitValidatedAuthContext(2, "user-a"), true);
});

test("a token replacement before fetch prevents the request from leaving", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = { current: { token: "token-a", generation: 7 } };
  t.after(installWindow(state));
  const request = await auth.prepareAuthRequest({
    url: "https://auth.openwhispr.test/api/auth/get-session",
    headers: new Headers(),
  });

  state.current = { token: "token-b", generation: 8 };
  let fetchCalls = 0;
  const previousFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}");
  };
  t.after(() => {
    global.fetch = previousFetch;
  });

  await assert.rejects(auth.authContextFetch(request.url, request), {
    code: "AUTH_CONTEXT_CHANGED",
  });
  assert.equal(fetchCalls, 0);
});

test("a token replacement while fetch is in flight discards the old response", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = { current: { token: "token-a", generation: 11 } };
  t.after(installWindow(state));
  const request = await auth.prepareAuthRequest({
    url: "https://auth.openwhispr.test/api/auth/get-session",
    headers: new Headers(),
  });

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const previousFetch = global.fetch;
  global.fetch = async () => pending;
  t.after(() => {
    global.fetch = previousFetch;
  });

  const responsePromise = auth.authContextFetch(request.url, request);
  state.current = { token: "token-b", generation: 12 };
  release(new Response(JSON.stringify({ user: { id: "user-a" } })));

  await assert.rejects(responsePromise, { code: "AUTH_CONTEXT_CHANGED" });
});

test("a transient get-session network failure keeps the binding but fences sync", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = { current: { token: "token-a", generation: 3 } };
  t.after(installWindow(state));

  await auth.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(3, "token-a"),
  });
  assert.equal(auth.commitValidatedAuthContext(3, "user-a"), true);
  assert.equal(auth.getValidatedAuthGeneration(), 3);

  const request = await auth.prepareAuthRequest({
    url: "https://auth.openwhispr.test/api/auth/get-session",
    headers: new Headers(),
  });
  const previousFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError("network down");
  };
  t.after(() => {
    global.fetch = previousFetch;
  });

  await assert.rejects(auth.authContextFetch(request.url, request), { message: "network down" });

  // The credential never changed, so the session stays presentable...
  assert.equal(auth.getBoundSessionGeneration("user-a"), 3);
  // ...but sync is fenced until a refetch succeeds.
  assert.equal(auth.getValidatedAuthGeneration(), null);
});

test("a get-session 401 clears the binding so the app drops to guest", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = { current: { token: "token-a", generation: 9 } };
  t.after(installWindow(state));

  await auth.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(9, "token-a"),
  });
  assert.equal(auth.getBoundSessionGeneration("user-a"), 9);

  // better-fetch routes a received 401 to onError (handleAuthRequestError),
  // never through authContextFetch's network catch.
  await auth.handleAuthRequestError({ request: sessionRequest(9, "token-a") });

  assert.equal(auth.getBoundSessionGeneration("user-a"), null);
});

async function failSessionFetch(t, auth, { signal } = {}) {
  const request = await auth.prepareAuthRequest({
    url: "https://auth.openwhispr.test/api/auth/get-session",
    headers: new Headers(),
    signal,
  });
  const previousFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError("network down");
  };
  t.after(() => {
    global.fetch = previousFetch;
  });
  await assert.rejects(auth.authContextFetch(request.url, request), { message: "network down" });
}

test("an offline launch presents the account main's binding names, with sync fenced", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 5 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));

  await failSessionFetch(t, auth);

  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 5 });
  // Presentation only: no session binds and nothing validates the generation.
  assert.equal(auth.getBoundSessionGeneration("user-a"), null);
  assert.equal(auth.commitValidatedAuthContext(5, "user-a"), false);
  assert.equal(auth.getValidatedAuthGeneration(), null);
  assert.equal(auth.hasValidatedAuthContext(), false);
});

test("a bearer the binding was not validated for is never presented offline", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-b", generation: 6 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));

  await failSessionFetch(t, auth);

  assert.equal(auth.getOfflineAccount(), null);
});

test("a server that cannot answer counts as offline", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 2 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));
  await auth.readAuthTokenState();

  await auth.handleAuthRequestError({
    request: sessionRequest(2, "token-a"),
    response: new Response("", { status: 503 }),
  });

  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 2 });
});

test("after a 401 the credential is never presented offline again", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 7 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));

  await failSessionFetch(t, auth);
  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 7 });

  await auth.handleAuthRequestError({
    request: sessionRequest(7, "token-a"),
    response: new Response("", { status: 401 }),
  });
  assert.equal(auth.getOfflineAccount(), null);

  await failSessionFetch(t, auth);
  assert.equal(auth.getOfflineAccount(), null);
});

test("a confirmed session or a new credential ends the offline account", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 8 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));

  await failSessionFetch(t, auth);
  await auth.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(8, "token-a"),
  });
  assert.equal(auth.getBoundSessionGeneration("user-a"), 8);
  // Still presented while reconciliation validates the answer, never signed out between.
  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 8 });
  assert.equal(auth.commitValidatedAuthContext(8, "user-a"), true);
  assert.equal(auth.getOfflineAccount(), null);

  // A refetch failure after a real answer is the transient case, not offline.
  await failSessionFetch(t, auth);
  assert.equal(auth.getOfflineAccount(), null);

  auth.resetAuthRequestContextForTests();
  await failSessionFetch(t, auth);
  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 8 });
  // Sign-out clears the token and crosses a generation.
  auth.observeAuthTokenStateEvent({ generation: 9, hasToken: false });
  assert.equal(auth.getOfflineAccount(), null);
});

test("a window that follows main's scope never presents an offline account", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 10 },
    binding: { accountId: "user-a", token: "token-a" },
    dictationWindow: true,
  };
  t.after(installWindow(state));

  // The dictation window's get-session always fails, online or not.
  await failSessionFetch(t, auth);
  await auth.handleAuthRequestError({
    request: sessionRequest(10, "token-a"),
    response: new Response("", { status: 503 }),
  });

  assert.equal(auth.getOfflineAccount(), null);
});

test("a proxy's 403 or 404 says nothing about the credential", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  for (const status of [403, 404, 407]) {
    auth.resetAuthRequestContextForTests();
    const state = {
      current: { token: "token-a", generation: 11 },
      binding: { accountId: "user-a", token: "token-a" },
    };
    const restore = installWindow(state);
    try {
      await auth.readAuthTokenState();
      await auth.handleAuthRequestError({
        request: sessionRequest(11, "token-a"),
        response: new Response("<html></html>", { status }),
      });
      assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 11 }, `${status}`);
    } finally {
      restore();
    }
  }
});

test("a 401 drops the saved profile, so no later launch presents it offline", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const values = new Map([["openwhispr:accountProfile", "{}"]]);
  const state = {
    current: { token: "token-a", generation: 12 },
    binding: { accountId: "user-a", token: "token-a" },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  t.after(installWindow(state));
  await auth.readAuthTokenState();

  await auth.handleAuthRequestError({
    request: sessionRequest(12, "token-a"),
    response: new Response("", { status: 401 }),
  });

  assert.equal(values.has("openwhispr:accountProfile"), false);
});

test("a session that resolved to no user stays a verdict through a later outage", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 13 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));

  await auth.handleAuthRequestSuccess({
    data: null,
    response: new Response("null", { status: 200 }),
    request: sessionRequest(13, "token-a"),
  });
  // A refetch then hits a 503 while reconciliation is still purging.
  await auth.handleAuthRequestError({
    request: sessionRequest(13, "token-a"),
    response: new Response("", { status: 503 }),
  });

  assert.equal(auth.getOfflineAccount(), null);
});

function answerSession(auth, generation, user) {
  return auth.handleAuthRequestSuccess({
    data: user ? { user } : null,
    response: new Response("{}", { status: 200 }),
    request: sessionRequest(generation, "token-a"),
  });
}

test("a session request Better Auth cancelled says nothing about the server", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 14 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));
  const controller = new AbortController();
  controller.abort();

  await failSessionFetch(t, auth, { signal: controller.signal });

  assert.equal(auth.getOfflineAccount(), null);
});

test("after a failed refetch only a new answer validates the session again", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 15 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));
  await answerSession(auth, 15, { id: "user-a" });
  assert.equal(auth.commitValidatedAuthContext(15, "user-a"), true);

  await failSessionFetch(t, auth);
  // The binding keeps presenting the account, but nothing re-validates it…
  assert.equal(auth.getBoundSessionGeneration("user-a"), 15);
  assert.equal(auth.commitValidatedAuthContext(15, "user-a"), false);
  assert.equal(auth.sessionAwaitsVerdict(), true);

  // …until the server answers again.
  await answerSession(auth, 15, { id: "user-a" });
  assert.equal(auth.commitValidatedAuthContext(15, "user-a"), true);
  assert.equal(auth.sessionAwaitsVerdict(), false);
});

test("a server error mid-session hands the account to the offline account in one step", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const state = {
    current: { token: "token-a", generation: 16 },
    binding: { accountId: "user-a", token: "token-a" },
  };
  t.after(installWindow(state));
  await answerSession(auth, 16, { id: "user-a" });
  auth.commitValidatedAuthContext(16, "user-a");
  const presented = [];
  t.after(
    auth.subscribeAuthRequestContext(() => {
      presented.push(
        auth.getBoundSessionGeneration("user-a") != null || auth.getOfflineAccount() != null
      );
    })
  );

  await auth.handleAuthRequestError({
    request: sessionRequest(16, "token-a"),
    response: new Response("", { status: 502 }),
  });

  assert.ok(presented.length > 0);
  assert.deepEqual(
    presented.filter((shown) => !shown),
    []
  );
  assert.deepEqual(auth.getOfflineAccount(), { userId: "user-a", generation: 16 });
});

test("each answer for a validated session refreshes the saved profile", async (t) => {
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const values = new Map();
  const state = {
    current: { token: "token-a", generation: 17 },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  t.after(installWindow(state));
  const user = { id: "user-a", name: "Ada", email: "ada@example.com" };

  // Not yet validated: reconciliation saves the first profile.
  await answerSession(auth, 17, user);
  assert.equal(values.has("openwhispr:accountProfile"), false);
  assert.equal(typeof auth.getSessionAnsweredAt(), "number");

  auth.commitValidatedAuthContext(17, "user-a");
  await answerSession(auth, 17, user);
  assert.equal(JSON.parse(values.get("openwhispr:accountProfile")).id, "user-a");
});
