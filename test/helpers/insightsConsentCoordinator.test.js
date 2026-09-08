const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/insightsConsentCoordinator.ts");

test("hook instances share one consent prompt for one auth context", async () => {
  const { answerInsightsConsent, requestInsightsConsent } = await load();
  const firstOwner = {};
  const secondOwner = {};
  const opened = [];
  let closed = 0;
  const first = requestInsightsConsent({
    accountId: "account-a",
    authGeneration: 7,
    kind: "enable",
    owner: firstOwner,
    open: (kind) => opened.push(`first:${kind}`),
    close: () => {
      closed += 1;
    },
  });
  const second = requestInsightsConsent({
    accountId: "account-a",
    authGeneration: 7,
    kind: "enable",
    owner: secondOwner,
    open: (kind) => opened.push(`second:${kind}`),
    close: () => {
      closed += 1;
    },
  });

  assert.strictEqual(second, first);
  assert.deepEqual(opened, ["first:enable"]);
  answerInsightsConsent(secondOwner, true);
  assert.equal(closed, 0, "a hook that does not own the dialog cannot answer it");
  answerInsightsConsent(firstOwner, true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(closed, 1);
});

test("a new auth context declines and closes the stale consent", async () => {
  const { answerInsightsConsent, requestInsightsConsent } = await load();
  const firstOwner = {};
  const secondOwner = {};
  let firstClosed = 0;
  let secondClosed = 0;
  const first = requestInsightsConsent({
    accountId: "account-a",
    authGeneration: 7,
    kind: "claim",
    owner: firstOwner,
    open() {},
    close: () => {
      firstClosed += 1;
    },
  });
  const second = requestInsightsConsent({
    accountId: "account-b",
    authGeneration: 8,
    kind: "claim",
    owner: secondOwner,
    open() {},
    close: () => {
      secondClosed += 1;
    },
  });

  assert.equal(await first, false);
  assert.equal(firstClosed, 1);
  answerInsightsConsent(secondOwner, true);
  assert.equal(await second, true);
  assert.equal(secondClosed, 1);
});
