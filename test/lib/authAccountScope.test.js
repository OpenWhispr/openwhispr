const test = require("node:test");
const assert = require("node:assert/strict");

const {
  accountScopeRequiresPurge,
  accountScopeRetryDelay,
  decideAccountScopeAction,
  getAccountScopeRevision,
  markAccountScopePurgeRequired,
  reconcileAccountScope,
  resetAccountScopeRetry,
  scheduleAccountScopeRetry,
  shouldBlockAccountScope,
  shouldReconcileAccountScope,
} = require("../../src/lib/authAccountScope.ts");

const decide = (overrides = {}) =>
  decideAccountScopeAction({
    userId: null,
    previousUserId: null,
    wasSignedIn: false,
    hasTeamSpaces: false,
    scopeValidated: true,
    purgeRequired: false,
    ...overrides,
  });

function installStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const previousWindow = global.window;
  global.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    values,
    restore: () => {
      global.window = previousWindow;
    },
  };
}

test("passive session loss purges the previous account scope", () => {
  assert.equal(
    decide({ previousUserId: "user-a", wasSignedIn: true, hasTeamSpaces: true }),
    "purge"
  );
});

test("a direct account replacement purges before remembering the new user", () => {
  assert.equal(decide({ userId: "user-b", previousUserId: "user-a", wasSignedIn: true }), "purge");
});

test("reauthentication after signed-out state purges any retained account scope", () => {
  assert.equal(decide({ userId: "user-a", previousUserId: "user-a", wasSignedIn: false }), "purge");
});

test("cached team capability is purged even when an older build stored no user id", () => {
  assert.equal(decide({ userId: "user-b", hasTeamSpaces: true }), "purge");
});

test("the current signed-in account remains ready without a destructive purge", () => {
  assert.equal(decide({ userId: "user-a", previousUserId: "user-a", wasSignedIn: true }), "none");
});

test("an unvalidated clean signed-out install validates locally while a signed-in install verifies", () => {
  assert.equal(decide({ scopeValidated: false }), "remember-user");
  assert.equal(decide({ userId: "user-a", scopeValidated: false }), "verify");
});

test("an upgrade validates its local database even with an existing signed-in marker", () => {
  assert.equal(decide({ userId: "user-a", wasSignedIn: true, scopeValidated: false }), "verify");
});

test("validated clean signed-out state remains local-only", () => {
  assert.equal(decide(), "none");
});

test("a failed or interrupted purge keeps the scope blocked after capability is cleared", () => {
  assert.equal(
    decide({
      userId: "user-b",
      wasSignedIn: false,
      hasTeamSpaces: false,
      scopeValidated: true,
      purgeRequired: true,
    }),
    "purge"
  );
});

test("grace suppresses a null-session flicker but never a resolved account replacement", () => {
  assert.equal(shouldBlockAccountScope(false, true, false, true), false);
  assert.equal(shouldReconcileAccountScope(false, true, false), false);
  assert.equal(shouldBlockAccountScope(false, true, true, true), true);
  assert.equal(shouldReconcileAccountScope(false, true, true), true);
});

test("grace cannot release an account transition after its purge becomes mandatory", () => {
  assert.equal(shouldBlockAccountScope(false, true, false, true, true), true);
});

test("a session fetch error blocks cached account scope without authorizing purge", () => {
  assert.equal(
    shouldBlockAccountScope(false, true, false, true, false, true),
    true,
    "unverified old-account content stays behind the auth gate even during grace"
  );
  assert.equal(
    shouldReconcileAccountScope(false, false, false, true),
    false,
    "a network error must not be interpreted as definitive sign-out"
  );

  assert.equal(
    shouldReconcileAccountScope(false, false, false, false),
    true,
    "resolved data:null/error:null remains a definitive no-session result"
  );
});

test("a rejected purge persists the required marker even after capability disappears", async (t) => {
  const { values, restore } = installStorage({
    "openwhispr:accountScopeUserId": "user-a",
    "openwhispr:accountScopeValidated": "true",
    isSignedIn: "true",
    teamSpacesCapability: "true",
  });
  t.after(restore);

  await assert.rejects(
    reconcileAccountScope(null, {
      purge: async () => {
        values.delete("teamSpacesCapability");
        throw new Error("database unavailable");
      },
      verify: async () => {
        throw new Error("unexpected verification");
      },
    }),
    /database unavailable/
  );

  assert.equal(values.get("openwhispr:accountScopePurgeRequired"), "true");
  assert.equal(accountScopeRequiresPurge(null), true);
});

test("the required marker survives clearing the legacy signed-in evidence", async (t) => {
  const { values, restore } = installStorage({
    "openwhispr:accountScopeValidated": "true",
    isSignedIn: "true",
  });
  t.after(restore);

  assert.equal(accountScopeRequiresPurge(null), true);
  markAccountScopePurgeRequired();
  values.set("isSignedIn", "false");

  let purgeCalls = 0;
  await reconcileAccountScope(null, {
    purge: async () => {
      purgeCalls += 1;
    },
    verify: async () => {
      throw new Error("unexpected verification");
    },
  });

  assert.equal(purgeCalls, 1);
  assert.equal(values.has("openwhispr:accountScopePurgeRequired"), false);
});

test("concurrent hook reconciliations share one purge and release only after verification", async (t) => {
  const { values, restore } = installStorage({
    "openwhispr:accountScopeUserId": "user-a",
    "openwhispr:accountScopeValidated": "true",
    isSignedIn: "true",
    teamSpacesCapability: "true",
  });
  t.after(restore);

  let release;
  const verificationGate = new Promise((resolve) => {
    release = resolve;
  });
  let purgeCalls = 0;
  const purge = async () => {
    purgeCalls += 1;
    await verificationGate;
    values.delete("teamSpacesCapability");
  };

  const callbacks = {
    purge,
    verify: async () => {
      throw new Error("unexpected verification");
    },
  };
  const reconciliations = [
    reconcileAccountScope(null, callbacks),
    reconcileAccountScope(null, callbacks),
    reconcileAccountScope(null, callbacks),
  ];
  release();
  await Promise.all(reconciliations);

  assert.equal(purgeCalls, 1);
  assert.equal(values.get("isSignedIn"), "false");
  assert.equal(values.has("openwhispr:accountScopeUserId"), false);
  assert.equal(values.has("openwhispr:accountScopePurgeRequired"), false);
  assert.equal(accountScopeRequiresPurge(null), false);
});

test("failed first-upgrade verification stays non-destructive and unvalidated", async (t) => {
  const { values, restore } = installStorage({
    isSignedIn: "true",
    teamSpacesCapability: "true",
  });
  t.after(restore);

  let purgeCalls = 0;
  await assert.rejects(
    reconcileAccountScope("user-a", {
      purge: async () => {
        purgeCalls += 1;
      },
      verify: async () => {
        throw new Error("offline");
      },
    }),
    /offline/
  );

  assert.equal(purgeCalls, 0);
  assert.equal(values.get("teamSpacesCapability"), "true");
  assert.equal(values.has("openwhispr:accountScopePurgeRequired"), false);
  assert.equal(values.has("openwhispr:accountScopeValidated"), false);
});

test("account reconciliation retry backoff is bounded", () => {
  assert.equal(accountScopeRetryDelay(0), 1000);
  assert.equal(accountScopeRetryDelay(1), 2000);
  assert.equal(accountScopeRetryDelay(5), 30000);
  assert.equal(accountScopeRetryDelay(100), 30000);
});

test("a failed reconciliation schedules a new revision without a reload", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetAccountScopeRetry();
  const before = getAccountScopeRevision();
  scheduleAccountScopeRetry("4:user-a");
  t.mock.timers.tick(999);
  assert.equal(getAccountScopeRevision(), before);
  t.mock.timers.tick(1);
  assert.equal(getAccountScopeRevision(), before + 1);
  resetAccountScopeRetry();
});
