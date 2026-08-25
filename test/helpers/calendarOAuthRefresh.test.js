const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

function loadOAuth(relativePath, runOAuthLoopbackFlow = null) {
  const modulePath = require.resolve(relativePath);
  delete require.cache[modulePath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") return { net: {}, shell: {} };
    if (
      runOAuthLoopbackFlow &&
      parent?.filename === modulePath &&
      request === "./oauthLoopbackFlow"
    ) {
      return {
        runOAuthLoopbackFlow,
        OAuthFlowError: class OAuthFlowError extends Error {
          constructor(redirectCode, message) {
            super(message);
            this.redirectCode = redirectCode;
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("initial OAuth callbacks honor disconnect invalidation before saving tokens", async () => {
  const loopbackOptions = new Map();
  const runCallback = (config) => {
    loopbackOptions.set(config.errorParam, config.loopbackHostname);
    return config.handleCallback("code", "redirect", "verifier");
  };
  const GoogleCalendarOAuth = loadOAuth("../../src/helpers/googleCalendarOAuth.js", runCallback);
  const MicrosoftCalendarOAuth = loadOAuth(
    "../../src/helpers/microsoftCalendarOAuth.js",
    runCallback
  );
  let googleSaves = 0;
  let microsoftSaves = 0;
  const google = new GoogleCalendarOAuth({ saveGoogleTokens: () => googleSaves++ });
  const microsoft = new MicrosoftCalendarOAuth({
    saveMicrosoftTokens: () => microsoftSaves++,
  });
  const idPayload = Buffer.from(JSON.stringify({ email: "google@example.com" })).toString(
    "base64url"
  );
  google.exchangeCodeForTokens = async () => ({
    access_token: "google-access",
    refresh_token: "google-refresh",
    expires_in: 3600,
    id_token: `header.${idPayload}.signature`,
  });
  microsoft.exchangeCodeForTokens = async () => ({
    access_token: "microsoft-access",
    refresh_token: "microsoft-refresh",
    expires_in: 3600,
  });
  microsoft.getClientId = () => "test-client-id";
  microsoft._resolveEmail = async () => "microsoft@example.com";

  await assert.rejects(
    google.startOAuthFlow({ shouldPersist: () => false }),
    /connection was cancelled/
  );
  await assert.rejects(
    microsoft.startOAuthFlow({ shouldPersist: () => false }),
    /connection was cancelled/
  );
  assert.equal(googleSaves, 0);
  assert.equal(microsoftSaves, 0);
  assert.equal(loopbackOptions.get("gcal_error"), undefined);
  assert.equal(loopbackOptions.get("mcal_error"), "localhost");
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a late Google token refresh cannot recreate a disconnected account", async () => {
  const GoogleCalendarOAuth = loadOAuth("../../src/helpers/googleCalendarOAuth.js");
  let row = {
    google_email: "google@example.com",
    access_token: "expired-access",
    refresh_token: "refresh-token",
    expires_at: 0,
    scope: "calendar",
  };
  const databaseManager = {
    getGoogleTokensByEmail: () => row,
    updateGoogleTokensAfterRefresh(tokens, expectedRefreshToken) {
      if (!row || row.refresh_token !== expectedRefreshToken) return { success: false };
      row = tokens;
      return { success: true };
    },
  };
  const oauth = new GoogleCalendarOAuth(databaseManager);
  const refresh = deferred();
  oauth.refreshAccessToken = () => refresh.promise;

  const accessToken = oauth.getValidAccessToken("google@example.com");
  row = null;
  refresh.resolve({ access_token: "late-access", expires_in: 3600 });

  await assert.rejects(accessToken, /disconnected during token refresh/);
  assert.equal(row, null);
});

test("a late Microsoft token rotation cannot recreate a disconnected account", async () => {
  const MicrosoftCalendarOAuth = loadOAuth("../../src/helpers/microsoftCalendarOAuth.js");
  let row = {
    microsoft_email: "microsoft@example.com",
    access_token: "expired-access",
    refresh_token: "old-refresh-token",
    expires_at: 0,
    scope: "calendar",
  };
  const databaseManager = {
    getMicrosoftTokensByEmail: () => row,
    updateMicrosoftTokensAfterRefresh(tokens, expectedRefreshToken) {
      if (!row || row.refresh_token !== expectedRefreshToken) return { success: false };
      row = tokens;
      return { success: true };
    },
  };
  const oauth = new MicrosoftCalendarOAuth(databaseManager);
  const refresh = deferred();
  oauth.refreshAccessToken = () => refresh.promise;

  const accessToken = oauth.getValidAccessToken("microsoft@example.com");
  row = null;
  refresh.resolve({
    access_token: "late-access",
    refresh_token: "rotated-refresh-token",
    expires_in: 3600,
  });

  await assert.rejects(accessToken, /disconnected during token refresh/);
  assert.equal(row, null);
});
