// One device with one renderer window: a single electronAPI bridge and a single
// SyncService kept across sign-ins, as a window that is never reloaded has, with
// the main process's token generation moving on every sign-in and sign-out and
// one fake cloud per sign-in. State a SyncService carries from one account to
// the next is invisible to a test that builds a new service for each sign-in.

const { createDb } = require("./db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./browserGlobals.js");
const { createElectronApi } = require("./electronApiBridge.js");
const { SyncService } = require("../../../src/services/SyncService.ts");
const auth = require("../../../src/lib/authRequestContext.ts");

const routeOf = (call) => String(call?.path ?? "").split("?")[0];

// Returns null when the database binding is unavailable and the test was skipped.
function createSyncDevice(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();

  const cloudsByGeneration = new Map();
  // `beforeRequest(call)` may return a promise to hold a request open. As in
  // cloudApiRequest.js, a request whose sign-in was replaced while it was out
  // answers AUTH_CONTEXT_CHANGED, whatever the cloud did with it; only a chat
  // create's success still comes back.
  const hooks = { beforeRequest: null };
  const router = {
    request: async (opts) => {
      const generation = api.authState.generation;
      await hooks.beforeRequest?.(opts);
      const result = await cloudsByGeneration.get(generation).request(opts);
      const chatCreated =
        result.success && opts.method === "POST" && routeOf(opts) === "/api/conversations/create";
      if (api.authState.generation === generation || chatCreated) return result;
      return {
        success: false,
        error: "Authentication context changed during request",
        code: "AUTH_CONTEXT_CHANGED",
        requestSent: true,
      };
    },
  };
  const api = createElectronApi(db, { cloud: router, snippets: true });
  windowStub.electronAPI = api;
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  let signedInBefore = false;

  return {
    db,
    api,
    service,
    hooks,
    // What set-active-account-scope and useAuth leave behind for a sign-in.
    async signIn(accountId, cloud) {
      if (signedInBefore) api.authState.generation += 1;
      signedInBefore = true;
      cloudsByGeneration.set(api.authState.generation, cloud);
      db.setActiveAccountId(accountId);
      db.claimSignedOutLocalRows();
      db.claimLegacyRowsOfOnlyAccount();
      await establishValidatedAuth(accountId);
    },
    // The token is cleared: main drops the account scope and the renderer its lease.
    signOut() {
      api.authState.generation += 1;
      db.setActiveAccountId(null);
      auth.resetAuthRequestContextForTests();
    },
  };
}

module.exports = { createSyncDevice, routeOf };
