// The renderer globals syncAll() actually reads: localStorage for the canSync
// gate and the sync cursors, navigator.locks for the cross-window lock.

const store = new Map();

const localStorageStub = {
  getItem(key) {
    const value = store.get(String(key));
    return value === undefined ? null : value;
  },
  setItem(key, value) {
    store.set(String(key), String(value));
  },
  removeItem(key) {
    store.delete(String(key));
  },
  clear() {
    store.clear();
  },
  key(index) {
    return [...store.keys()][index] ?? null;
  },
  get length() {
    return store.size;
  },
};

const held = new Set();
const waiters = new Map();

function queueFor(name) {
  let queue = waiters.get(name);
  if (!queue) {
    queue = [];
    waiters.set(name, queue);
  }
  return queue;
}

async function holdAndRun(name, callback) {
  held.add(name);
  try {
    return await callback({ name, mode: "exclusive" });
  } finally {
    held.delete(name);
    const next = waiters.get(name)?.shift();
    if (next) next();
  }
}

async function requestLock(name, optionsOrCallback, maybeCallback) {
  const options = typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {});
  const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  if (typeof callback !== "function") {
    throw new TypeError("navigator.locks.request requires a callback");
  }

  if (held.has(String(name))) {
    // ifAvailable hands the caller a null lock instead of queueing, which is how
    // an ambient sync pass bows out while another window holds the lock.
    if (options.ifAvailable) return callback(null);
    return new Promise((resolve, reject) => {
      queueFor(String(name)).push(() => holdAndRun(String(name), callback).then(resolve, reject));
    });
  }
  return holdAndRun(String(name), callback);
}

const navigatorStub = { locks: { request: requestLock } };

const documentStub = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: localStorageStub,
  navigator: navigatorStub,
  document: documentStub,
  // authRequestContext resolves get-session URLs against the window origin.
  location: { origin: "https://harness.openwhispr.test" },
};

function define(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function installBrowserGlobals() {
  define("localStorage", localStorageStub);
  define("navigator", navigatorStub);
  define("document", documentStub);
  define("window", windowStub);
  return windowStub;
}

// Marks the three keys canSync() requires; without all three every sync path
// returns before doing any work.
function enableSync() {
  localStorageStub.setItem("isSignedIn", "true");
  localStorageStub.setItem("cloudBackupEnabled", "true");
  localStorageStub.setItem("isSubscribed", "true");
}

function resetBrowserGlobals() {
  store.clear();
  held.clear();
  waiters.clear();
  documentStub.visibilityState = "visible";
  delete windowStub.electronAPI;
  delete globalThis.electronAPI;
}

// Takes the lock out of band so a test can drive the "another window is
// syncing" path. Returns the release function.
async function acquireLock(name) {
  let release;
  const acquired = new Promise((resolve) => {
    void requestLock(
      name,
      () =>
        new Promise((done) => {
          release = done;
          resolve();
        })
    );
  });
  await acquired;
  return () => release();
}

// syncAll() refuses to run without a validated auth context: a token
// generation bound to a resolved get-session user. Drive the real
// authRequestContext module through its exported surface so the harness holds
// the same lease the renderer would after sign-in. Requires
// window.electronAPI.authGetTokenState (the bridge provides it).
async function establishValidatedAuth(userId = "user-harness") {
  const auth = require("../../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  const request = await auth.prepareAuthRequest({
    url: `${windowStub.location.origin}/api/auth/get-session`,
    headers: {},
  });
  await auth.handleAuthRequestSuccess({
    data: { user: { id: userId } },
    response: new Response(null),
    request,
  });
  const { generation } = await auth.readAuthTokenState();
  if (!auth.commitValidatedAuthContext(generation, userId)) {
    throw new Error("harness auth bootstrap failed to validate the session");
  }
}

// A failed team-spaces probe schedules a real-timer retry that would fire long
// after the test closed its database; every SyncService a test creates must be
// swept before the test ends.
function stopSyncTimers(service) {
  if (!service) return;
  if (service.teamSpacesRetryTimer) {
    clearTimeout(service.teamSpacesRetryTimer);
    service.teamSpacesRetryTimer = null;
  }
  if (service.openNoteSyncTimer) {
    clearInterval(service.openNoteSyncTimer);
    service.openNoteSyncTimer = null;
  }
  for (const timer of service.pushTimers?.values?.() ?? []) clearTimeout(timer);
  service.pushTimers?.clear?.();
}

module.exports = {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  acquireLock,
  localStorage: localStorageStub,
  navigator: navigatorStub,
  document: documentStub,
  window: windowStub,
};
