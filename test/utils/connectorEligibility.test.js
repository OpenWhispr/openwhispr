const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/connectorEligibility.ts");

const UNMANAGED = { status: "unmanaged", policy: null, appVersion: null };
const NO_USAGE = { status: "idle" };
const input = (overrides = {}) => ({
  cloudEnabled: false,
  titanium: { signedIn: true, accountBound: true, licensed: true },
  upstream: { isSignedIn: false, usage: NO_USAGE, isSubscribed: false, policy: UNMANAGED },
  ...overrides,
});

test("fork: a signed-in, account-bound, licensed Titanium user is eligible", async () => {
  const { connectorEligibilityFor } = await load();
  assert.deepEqual(connectorEligibilityFor(input()), {
    isPaid: true,
    blockedByOrg: false,
    connectorsAllowed: true,
    reason: null,
  });
});

test("fork: each missing precondition names its reason, in order", async () => {
  const { connectorEligibilityFor } = await load();
  const reason = (titanium) => connectorEligibilityFor(input({ titanium })).reason;
  assert.equal(reason({ signedIn: false, accountBound: true, licensed: true }), "signedOut");
  assert.equal(reason({ signedIn: true, accountBound: false, licensed: true }), "reauthRequired");
  assert.equal(reason({ signedIn: true, accountBound: true, licensed: false }), "planRequired");
  for (const titanium of [
    { signedIn: false, accountBound: false, licensed: false },
    { signedIn: true, accountBound: false, licensed: false },
    { signedIn: true, accountBound: true, licensed: false },
  ]) {
    assert.equal(connectorEligibilityFor(input({ titanium })).isPaid, false);
  }
});

test("fork: the OpenWhispr session, plan and org policy are never consulted", async () => {
  const { connectorEligibilityFor } = await load();
  const upstream = {
    isSignedIn: true,
    usage: { status: "success", data: { isSubscribed: true, isTrial: false } },
    isSubscribed: true,
    policy: { status: "error", policy: null, appVersion: null },
  };
  const unlicensed = connectorEligibilityFor(
    input({ upstream, titanium: { signedIn: true, accountBound: true, licensed: false } })
  );
  assert.equal(unlicensed.isPaid, false, "an OpenWhispr plan does not unlock a fork");
  const licensed = connectorEligibilityFor(input({ upstream }));
  assert.equal(licensed.connectorsAllowed, true, "a failed org-policy fetch does not lock a fork");
});

test("upstream: signed in with a plan is eligible; the Titanium state is ignored", async () => {
  const { connectorEligibilityFor, hasConnectorPlan } = await load();
  const usage = { status: "success", data: { isSubscribed: true, isTrial: false } };
  const signedOutTitanium = { signedIn: false, accountBound: false, licensed: false };
  const eligible = connectorEligibilityFor(
    input({
      cloudEnabled: true,
      titanium: signedOutTitanium,
      upstream: { isSignedIn: true, usage, isSubscribed: false, policy: UNMANAGED },
    })
  );
  assert.equal(eligible.isPaid, true);
  assert.equal(eligible.reason, null);
  assert.equal(hasConnectorPlan(usage, false), true);

  const noPlan = connectorEligibilityFor(
    input({
      cloudEnabled: true,
      upstream: { isSignedIn: true, usage: NO_USAGE, isSubscribed: false, policy: UNMANAGED },
    })
  );
  assert.deepEqual([noPlan.isPaid, noPlan.reason], [false, "planRequired"]);

  const signedOut = connectorEligibilityFor(
    input({
      cloudEnabled: true,
      upstream: { isSignedIn: false, usage, isSubscribed: true, policy: UNMANAGED },
    })
  );
  assert.deepEqual([signedOut.isPaid, signedOut.reason], [false, "signedOut"]);
});

test("upstream: an org that turns connectors off blocks them, and a failed fetch fails closed", async () => {
  const { connectorEligibilityFor } = await load();
  const upstream = (policy) => ({
    isSignedIn: true,
    usage: { status: "success", data: { isSubscribed: true, isTrial: false } },
    isSubscribed: true,
    policy,
  });
  const managedOff = {
    status: "managed",
    appVersion: "1.10.0",
    policy: {
      minAppVersion: null,
      features: { connectorsEnabled: false },
    },
  };
  const result = connectorEligibilityFor(
    input({ cloudEnabled: true, upstream: upstream(managedOff) })
  );
  assert.equal(result.blockedByOrg, true);
  const failed = connectorEligibilityFor(
    input({
      cloudEnabled: true,
      upstream: upstream({ status: "error", policy: null, appVersion: null }),
    })
  );
  assert.equal(failed.connectorsAllowed, false);
});

test("calendar connect: offered unless main says the OAuth client id is missing", async () => {
  const { isCalendarOAuthConfigured } = await load();
  const both = { google: true, microsoft: true };
  assert.equal(isCalendarOAuthConfigured(both, "google"), true);
  assert.equal(isCalendarOAuthConfigured({ google: false, microsoft: true }, "google"), false);
  assert.equal(isCalendarOAuthConfigured({ google: false, microsoft: true }, "microsoft"), true);
  assert.equal(isCalendarOAuthConfigured({ google: true, microsoft: false }, "microsoft"), false);
  // main's answer not here yet: offered, and main refuses a flow without a client id
  assert.equal(isCalendarOAuthConfigured(null, "google"), true);
});

test("home connect card: hidden while unanswered and when no calendar OAuth client is built in", async () => {
  const { shouldShowCalendarConnectCard } = await load();
  assert.equal(shouldShowCalendarConnectCard(null), false);
  assert.equal(shouldShowCalendarConnectCard({ google: false, microsoft: false }), false);
  assert.equal(shouldShowCalendarConnectCard({ google: true, microsoft: false }), true);
  assert.equal(shouldShowCalendarConnectCard({ google: false, microsoft: true }), true);
});
