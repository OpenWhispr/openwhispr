const test = require("node:test");
const assert = require("node:assert/strict");

function installWindow(state) {
  const previousWindow = global.window;
  const values = new Map();
  global.window = {
    location: {
      origin: "https://desktop.openwhispr.test",
      href: "https://desktop.openwhispr.test",
    },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    electronAPI: {
      onAuthTokenStateChanged: () => () => {},
      authGetTokenState: async () => ({ ...state.tokenState }),
      authSetToken: async () => ({ success: true, ...state.tokenState }),
      cloudApiRequest: async (request) => {
        state.requests.push(request);
        return { success: true, data: { deleted: true } };
      },
    },
  };
  return () => {
    global.window = previousWindow;
  };
}

test("account deletion uses the validated bearer-generation cloud boundary", async (t) => {
  const authContext = await import("../../src/lib/authRequestContext.ts");
  authContext.resetAuthRequestContextForTests();
  const state = {
    tokenState: { token: "token-a", generation: 7 },
    requests: [],
  };
  t.after(installWindow(state));

  await authContext.handleAuthRequestSuccess({
    data: { user: { id: "user-a" } },
    response: new Response("{}", { status: 200 }),
    request: {
      url: "https://auth.openwhispr.test/api/auth/get-session",
      headers: new Headers({ Authorization: "Bearer token-a" }),
      openWhisprAuthGeneration: 7,
    },
  });
  assert.equal(authContext.commitValidatedAuthContext(7, "user-a"), true);

  const previousFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("account deletion bypassed the main-process auth fence");
  };
  t.after(() => {
    global.fetch = previousFetch;
  });

  const { deleteAccount } = await import("../../src/lib/accountDeletionRequest.ts");
  await deleteAccount();

  assert.deepEqual(state.requests, [
    {
      method: "DELETE",
      path: "/api/auth/delete-account",
      body: undefined,
      public: undefined,
      expectedAuthGeneration: 7,
    },
  ]);
});
