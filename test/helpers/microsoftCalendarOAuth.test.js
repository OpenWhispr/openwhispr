const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const oauthModulePath = require.resolve("../../src/helpers/microsoftCalendarOAuth.js");
const originalLoad = Module._load;
let flowOptions = null;

function loadOAuth() {
  delete require.cache[oauthModulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return { net: {} };
    if (request === "./oauthLoopbackFlow") {
      return {
        runOAuthLoopbackFlow: (options) => {
          flowOptions = options;
          return options;
        },
        OAuthFlowError: Error,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(oauthModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const idToken = (claims) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

function createOAuth(saved) {
  const MicrosoftCalendarOAuth = loadOAuth();
  return new MicrosoftCalendarOAuth({ saveMicrosoftTokens: (tokens) => saved.push(tokens) });
}

test("signing in stores and returns the id_token's tenant", async () => {
  const saved = [];
  const oauth = createOAuth(saved);
  oauth.getClientId = () => "client-id";
  oauth.startOAuthFlow();
  oauth.exchangeCodeForTokens = async () => ({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    id_token: idToken({ email: "chad@corp.test", tid: "tenant-1" }),
  });

  const result = await flowOptions.handleCallback("code", "http://127.0.0.1/cb", "verifier");

  assert.deepEqual(result, { success: true, email: "chad@corp.test", tenantId: "tenant-1" });
  assert.equal(saved[0].tenant_id, "tenant-1");
});

test("a refresh without an id_token saves no tenant, so the stored one is kept", async () => {
  const saved = [];
  const oauth = createOAuth(saved);
  oauth.refreshAccessToken = async () => ({ access_token: "new", expires_in: 3600 });

  await oauth._refreshAndSaveTokens({
    microsoft_email: "chad@corp.test",
    refresh_token: "refresh",
    scope: "scope",
  });

  assert.equal(saved[0].tenant_id, null);
  assert.equal(saved[0].refresh_token, "refresh");
});

test("a refresh with an id_token saves its tenant", async () => {
  const saved = [];
  const oauth = createOAuth(saved);
  oauth.refreshAccessToken = async () => ({
    access_token: "new",
    expires_in: 3600,
    id_token: idToken({ tid: "tenant-2" }),
  });

  await oauth._refreshAndSaveTokens({ microsoft_email: "chad@corp.test", refresh_token: "r" });

  assert.equal(saved[0].tenant_id, "tenant-2");
});
