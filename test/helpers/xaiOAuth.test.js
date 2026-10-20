const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const crypto = require("node:crypto");
const xaiModulePath = require.resolve("../../src/helpers/xaiOAuth.js");
const originalLoad = Module._load;

function loadXai({ openExternal = () => {} } = {}) {
  delete require.cache[xaiModulePath];
  delete require.cache[require.resolve("../../src/helpers/oauthLoopbackFlow.js")];
  delete require.cache[require.resolve("../../src/helpers/externalUrlOpener.js")];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(xaiModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function memoryStore(initial = null) {
  let creds = initial;
  return {
    load: async () => creds,
    save: async (next) => {
      creds = next;
    },
    clear: async () => {
      creds = null;
    },
  };
}

test("SuperGrok completes its fixed loopback login with PKCE", async () => {
  let resolveAuthorizeUrl;
  const authorizeUrlOpened = new Promise((resolve) => {
    resolveAuthorizeUrl = resolve;
  });
  let stored;
  let exchangedVerifier;
  const { XaiOAuth } = loadXai({
    openExternal: (url) => resolveAuthorizeUrl(url),
  });
  const oauth = new XaiOAuth({
    store: {
      load: async () => null,
      save: async (credentials) => {
        stored = credentials;
      },
      clear: async () => {
        stored = null;
      },
    },
    postForm: async (_url, body) => {
      const fields = new URLSearchParams(body);
      assert.equal(fields.get("grant_type"), "authorization_code");
      assert.equal(fields.get("code"), "authorization-code");
      assert.equal(fields.get("redirect_uri"), "http://127.0.0.1:56121/callback");
      assert.equal(fields.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
      const verifier = fields.get("code_verifier");
      exchangedVerifier = verifier;
      assert.match(verifier, /^[A-Za-z0-9_-]{86}$/);
      assert.equal(
        fields.get("code_challenge"),
        crypto.createHash("sha256").update(verifier).digest("base64url")
      );
      assert.equal(fields.get("code_challenge_method"), "S256");
      return {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "api:access",
      };
    },
  });

  let authorizeUrl;
  let flow;
  let settled = false;
  try {
    flow = oauth.startOAuthFlow();
    flow
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    authorizeUrl = new URL(
      await Promise.race([
        authorizeUrlOpened,
        flow.then(
          () => Promise.reject(new Error("OAuth flow settled before opening the authorize URL")),
          (error) => Promise.reject(error)
        ),
      ])
    );
    assert.equal(
      `${authorizeUrl.origin}${authorizeUrl.pathname}`,
      "https://auth.x.ai/oauth2/authorize"
    );
    assert.equal(
      authorizeUrl.searchParams.get("client_id"),
      "b1a00492-073a-47ea-816f-4c329264a828"
    );
    assert.equal(authorizeUrl.searchParams.get("plan"), "generic");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:56121/callback");
    assert.match(authorizeUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizeUrl.searchParams.get("scope"), /\boffline_access\b/);

    const callbackUrl = new URL(authorizeUrl.searchParams.get("redirect_uri"));
    callbackUrl.searchParams.set("code", "authorization-code");
    callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state"));
    const response = await fetch(callbackUrl, { redirect: "manual" });
    assert.equal(response.status, 302);

    const result = await flow;
    assert.deepEqual(result, {
      connected: true,
      expiresAt: stored.expires_at,
      scope: "api:access",
    });
    assert.equal(stored.access_token, "access-token");
    assert.equal(stored.refresh_token, "refresh-token");
    assert.equal(
      authorizeUrl.searchParams.get("code_challenge"),
      crypto.createHash("sha256").update(exchangedVerifier).digest("base64url")
    );
  } finally {
    if (!settled && authorizeUrl) {
      const callbackUrl = new URL(authorizeUrl.searchParams.get("redirect_uri"));
      callbackUrl.searchParams.set("code", "cleanup");
      callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state"));
      await fetch(callbackUrl, { redirect: "manual" }).catch(() => {});
      await flow.catch(() => {});
    }
  }
});

test("exchange posts authorization_code with PKCE challenge", async () => {
  const { XaiOAuth, XAI_TOKEN_ENDPOINT, s256Challenge } = loadXai();
  const posts = [];
  const oauth = new XaiOAuth({
    store: memoryStore(),
    postForm: async (url, body) => {
      posts.push({ url, body });
      return { access_token: "tok", refresh_token: "ref", expires_in: 60 };
    },
  });
  await oauth.exchangeCodeForTokens("the-code", "http://127.0.0.1:56121/callback", "verifier");
  assert.equal(posts[0].url, XAI_TOKEN_ENDPOINT);
  const fields = new URLSearchParams(posts[0].body);
  assert.equal(fields.get("grant_type"), "authorization_code");
  assert.equal(fields.get("code"), "the-code");
  assert.equal(fields.get("code_verifier"), "verifier");
  assert.equal(fields.get("code_challenge"), s256Challenge("verifier"));
  assert.equal(fields.get("code_challenge_method"), "S256");
});

test("getValidAccessToken refreshes near expiry and saves the new grant", async () => {
  const { XaiOAuth } = loadXai();
  const store = memoryStore({
    access_token: "old",
    refresh_token: "ref",
    expires_at: Date.now() + 1000,
    scope: "api:access",
  });
  const oauth = new XaiOAuth({
    store,
    postForm: async (_url, body) => {
      const fields = new URLSearchParams(body);
      assert.equal(fields.get("grant_type"), "refresh_token");
      assert.equal(fields.get("refresh_token"), "ref");
      return { access_token: "new", refresh_token: "ref2", expires_in: 3600, scope: "api:access" };
    },
  });
  const token = await oauth.getValidAccessToken();
  assert.equal(token, "new");
  const saved = await store.load();
  assert.equal(saved.access_token, "new");
  assert.equal(saved.refresh_token, "ref2");
  assert.equal(saved.scope, "api:access");
});

test("getValidAccessToken reuses a fresh access token without posting", async () => {
  const { XaiOAuth } = loadXai();
  let posts = 0;
  const oauth = new XaiOAuth({
    store: memoryStore({
      access_token: "live",
      refresh_token: "ref",
      expires_at: Date.now() + 10 * 60 * 1000,
    }),
    postForm: async () => {
      posts += 1;
      return {};
    },
  });
  assert.equal(await oauth.getValidAccessToken(), "live");
  assert.equal(posts, 0);
});

test("4xx refresh raises ReauthRequired", async () => {
  const { XaiOAuth, ReauthRequired } = loadXai();
  const oauth = new XaiOAuth({
    store: memoryStore({
      access_token: "old",
      refresh_token: "dead",
      expires_at: Date.now() - 1000,
    }),
    postForm: async () => ({ status: 401, error: "invalid_grant" }),
  });
  await assert.rejects(() => oauth.getValidAccessToken(), ReauthRequired);
});

test("status never includes tokens", async () => {
  const { XaiOAuth } = loadXai();
  const oauth = new XaiOAuth({
    store: memoryStore({
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      expires_at: 123,
      scope: "api:access",
    }),
  });
  const status = await oauth.status();
  assert.deepEqual(status, { connected: true, expiresAt: 123, scope: "api:access" });
  assert.equal(JSON.stringify(status).includes("secret"), false);
});

test("concurrent getValidAccessToken refreshes once", async () => {
  const { XaiOAuth } = loadXai();
  let posts = 0;
  const oauth = new XaiOAuth({
    store: memoryStore({
      access_token: "old",
      refresh_token: "ref",
      expires_at: Date.now() - 1,
    }),
    postForm: async () => {
      posts += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { access_token: "new", refresh_token: "ref", expires_in: 3600 };
    },
  });
  const [a, b] = await Promise.all([oauth.getValidAccessToken(), oauth.getValidAccessToken()]);
  assert.equal(a, "new");
  assert.equal(b, "new");
  assert.equal(posts, 1);
});
