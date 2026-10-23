const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("./rendererTestHarness");

const KEY = "openwhispr:accountProfile";
const DAY = 24 * 60 * 60 * 1000;
const USER = {
  id: "user-a",
  name: "Ada",
  email: "ada@example.com",
  image: "https://example.com/a.png",
  emailVerified: true,
  createdAt: "2026-01-01",
};

async function load() {
  return import("../../src/lib/offlineAccountProfile.ts");
}

test("the profile reads back only for the account that wrote it", async (t) => {
  installBrowserGlobals(t);
  const profiles = await load();
  profiles.writeOfflineAccountProfile(USER, 1_000);

  assert.deepEqual(profiles.readOfflineAccountProfile("user-a", 1_000), {
    id: "user-a",
    name: "Ada",
    email: "ada@example.com",
    image: "https://example.com/a.png",
    emailVerified: true,
  });
  assert.equal(profiles.readOfflineAccountProfile("user-b", 1_000), null);
  assert.equal(profiles.readOfflineAccountProfile(null, 1_000), null);
});

test("a profile older than 30 days, from the future or malformed is not read", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const profiles = await load();
  profiles.writeOfflineAccountProfile(USER, 0);

  assert.ok(profiles.readOfflineAccountProfile("user-a", 30 * DAY));
  assert.equal(profiles.readOfflineAccountProfile("user-a", 30 * DAY + 1), null);
  assert.equal(profiles.readOfflineAccountProfile("user-a", -1), null);

  storage.setItem(KEY, "{not json");
  assert.equal(profiles.readOfflineAccountProfile("user-a", 0), null);
  storage.setItem(KEY, JSON.stringify({ id: "user-a" }));
  assert.equal(profiles.readOfflineAccountProfile("user-a", 0), null);
});

test("clearing removes the profile", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const profiles = await load();
  profiles.writeOfflineAccountProfile(USER);
  profiles.clearOfflineAccountProfile();
  assert.equal(storage.getItem(KEY), null);
});

const OFFLINE = { userId: "user-a", generation: 4 };
const PROFILE = { id: "user-a", name: "Ada", email: "", image: null, emailVerified: false };
const presentable = {
  isPending: false,
  sessionBound: false,
  offlineAccount: OFFLINE,
  scopeAction: "none",
  profile: PROFILE,
};

test("the offline account is presented when the local scope is already this account", async () => {
  const { resolveOfflineAccount } = await load();
  assert.deepEqual(resolveOfflineAccount(presentable), { ...OFFLINE, profile: PROFILE });
});

test("any pending reconciliation, a live session or a mismatched profile stays a guest", async () => {
  const { resolveOfflineAccount } = await load();
  for (const scopeAction of ["purge", "verify", "remember-user"]) {
    assert.equal(resolveOfflineAccount({ ...presentable, scopeAction }), null, scopeAction);
  }
  assert.equal(resolveOfflineAccount({ ...presentable, isPending: true }), null);
  assert.equal(resolveOfflineAccount({ ...presentable, sessionBound: true }), null);
  assert.equal(resolveOfflineAccount({ ...presentable, offlineAccount: null }), null);
  assert.equal(resolveOfflineAccount({ ...presentable, profile: null }), null);
  assert.equal(
    resolveOfflineAccount({ ...presentable, profile: { ...PROFILE, id: "user-b" } }),
    null
  );
});
