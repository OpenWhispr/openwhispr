const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function setup(provider) {
  const modulePath = require.resolve(`../../src/helpers/${provider.toLowerCase()}CalendarOAuth`);
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === modulePath) {
      if (request === "electron") return { net: {} };
      if (request === "./oauthLoopbackFlow") return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let OAuth;
  try {
    OAuth = require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
  const email = "person@example.test";
  let tokens = {
    [`${provider.toLowerCase()}_email`]: email,
    access_token: "expired",
    refresh_token: "original-refresh",
    expires_at: 0,
    scope: "calendar",
  };
  const saved = [];
  const oauth = new OAuth({
    [`get${provider}TokensByEmail`]: () => tokens && { ...tokens },
    [`save${provider}Tokens`]: (next) => {
      saved.push(next);
      tokens = next;
    },
  });
  const responses = [];
  oauth.refreshAccessToken = () => {
    const response = deferred();
    responses.push(response);
    return response.promise;
  };
  return {
    oauth,
    email,
    responses,
    saved,
    get tokens() {
      return tokens;
    },
    set tokens(value) {
      tokens = value;
    },
  };
}

for (const provider of ["Google", "Microsoft"]) {
  test(`${provider}: an unchanged calendar login saves and returns its refreshed token`, async () => {
    const state = setup(provider);
    const pending = state.oauth.getValidAccessToken(state.email);
    state.responses[0].resolve({ access_token: "fresh", expires_in: 3600 });
    assert.equal(await pending, "fresh");
    assert.equal(state.tokens.access_token, "fresh");
    assert.equal(state.tokens.refresh_token, "original-refresh");
  });

  test(`${provider}: a refresh cannot recreate a disconnected calendar account`, async () => {
    const state = setup(provider);
    const pending = state.oauth.getValidAccessToken(state.email);
    const rejected = assert.rejects(pending, /changed|disconnected/i);
    // removeAccount/clearCalendarData deletes the credential row synchronously.
    state.tokens = null;
    state.responses[0].resolve({ access_token: "late", expires_in: 3600 });
    await rejected;
    assert.equal(state.tokens, null);
    assert.equal(state.saved.length, 0);
  });
}

for (const provider of ["Google", "Microsoft"]) {
  test(`${provider}: concurrent callers share the refresh for the same credential`, async () => {
    const state = setup(provider);
    const first = state.oauth.getValidAccessToken(state.email);
    const second = state.oauth.getValidAccessToken(state.email);
    assert.equal(state.responses.length, 1);
    state.responses[0].resolve({ access_token: "fresh", expires_in: 3600 });
    assert.deepEqual(await Promise.all([first, second]), ["fresh", "fresh"]);
    assert.equal(state.saved.length, 1);
  });

  test(`${provider}: a reconnect starts its own refresh while the old login finishes`, async () => {
    const state = setup(provider);
    const old = state.oauth.getValidAccessToken(state.email);
    const rejected = assert.rejects(old, /changed|disconnected/i);
    state.tokens = { ...state.tokens, access_token: "reconnected", refresh_token: "new-login" };
    const next = state.oauth.getValidAccessToken(state.email);
    assert.equal(state.responses.length, 2);
    state.responses[0].resolve({ access_token: "stale", expires_in: 3600 });
    await rejected;
    const joined = state.oauth.getValidAccessToken(state.email);
    assert.equal(state.responses.length, 2, "old completion must not remove the new flight");
    state.responses[1].resolve({ access_token: "fresh", expires_in: 3600 });
    assert.deepEqual(await Promise.all([next, joined]), ["fresh", "fresh"]);
    assert.equal(state.tokens.refresh_token, "new-login");
  });
}
