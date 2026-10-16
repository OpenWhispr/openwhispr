const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const environmentPath = require.resolve("../../src/helpers/environment");
const originalLoad = Module._load;

function loadEnvironmentManager(userDataDirectory, { oauthToken, oauthErrorName } = {}) {
  delete require.cache[environmentPath];
  process.resourcesPath = userDataDirectory;
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => userDataDirectory, getAppPath: () => userDataDirectory, isReady: () => false },
        safeStorage: { isEncryptionAvailable: () => false },
      };
    }
    if (request === "dotenv") {
      return { config: () => ({ parsed: {} }) };
    }
    if (request === "./i18nMain") {
      return { normalizeUiLanguage: (language) => language || "" };
    }
    if (request === "./secretCrypto") {
      return {
        isAvailable: () => true,
        encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
        decrypt: (blob) => ({ value: Buffer.from(blob).toString("utf8"), needsReencrypt: false }),
      };
    }
    if (request === "./xaiOAuth") {
      class ReauthRequired extends Error {
        constructor(message) {
          super(message);
          this.name = "ReauthRequired";
        }
      }
      class XaiOAuth {
        constructor({ store }) {
          this.store = store;
        }
        async getValidAccessToken() {
          if (oauthErrorName === "ReauthRequired") {
            throw new ReauthRequired("no SuperGrok session");
          }
          if (oauthErrorName) {
            throw new Error("refresh failed");
          }
          if (oauthToken) return oauthToken;
          const creds = await this.store.load();
          if (!creds?.access_token) throw new ReauthRequired("no SuperGrok session");
          return creds.access_token;
        }
        async logout() {
          await this.store.clear();
          return { connected: false, expiresAt: null, scope: "" };
        }
      }
      return { XaiOAuth, ReauthRequired };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(environmentPath);
  } finally {
    Module._load = originalLoad;
  }
}

test("getXaiBearer prefers SuperGrok access token over console key", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-xai-bearer-"));
  const previousKey = process.env.XAI_API_KEY;
  t.after(() => {
    delete require.cache[environmentPath];
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  });
  process.env.XAI_API_KEY = "xk-console";
  const EnvironmentManager = loadEnvironmentManager(userDataDirectory, { oauthToken: "oauth-access" });
  const env = new EnvironmentManager();
  assert.equal(await env.getXaiBearer(), "oauth-access");
});

test("getXaiBearer falls back to console key on ReauthRequired", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-xai-bearer-"));
  t.after(() => {
    delete require.cache[environmentPath];
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
    delete process.env.XAI_API_KEY;
  });
  process.env.XAI_API_KEY = "xk-console";
  const EnvironmentManager = loadEnvironmentManager(userDataDirectory, {
    oauthErrorName: "ReauthRequired",
  });
  const env = new EnvironmentManager();
  await env.saveXaiOAuthCredentials({
    access_token: "stale",
    refresh_token: "dead",
    expires_at: Date.now() - 1000,
  });
  assert.equal(await env.getXaiBearer(), "xk-console");
  assert.equal(await env.loadXaiOAuthCredentials(), null);
});

test("OAuth JSON is stored encrypted and never copied to process.env", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-xai-oauth-store-"));
  t.after(() => {
    delete require.cache[environmentPath];
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });
  delete process.env.XAI_OAUTH_CREDENTIALS;
  const EnvironmentManager = loadEnvironmentManager(userDataDirectory);
  const env = new EnvironmentManager();
  const creds = {
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 60_000,
    token_type: "Bearer",
    scope: "api:access",
  };
  await env.saveXaiOAuthCredentials(creds);
  assert.equal(process.env.XAI_OAUTH_CREDENTIALS, undefined);
  assert.equal(process.env.XAI_API_KEY === "at", false);
  const filePath = path.join(userDataDirectory, "secure-keys", "XAI_OAUTH_CREDENTIALS.enc");
  assert.equal(fs.existsSync(filePath), true);
  const loaded = await env.loadXaiOAuthCredentials();
  assert.equal(loaded.access_token, "at");
  await env.clearXaiOAuthCredentials();
  assert.equal(fs.existsSync(filePath), false);
});
