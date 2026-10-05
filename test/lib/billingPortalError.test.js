const test = require("node:test");
const assert = require("node:assert/strict");

const { billingPortalErrorCopy } = require("../../src/lib/billingPortalError.ts");

test("a non-owner refusal points at the workspace owner", () => {
  const copy = billingPortalErrorCopy("not_workspace_owner");
  assert.equal(copy.titleKey, "settingsPage.account.billing.contactOwnerTitle");
  assert.equal(copy.descriptionKey, "settingsPage.account.billing.contactOwnerDescription");
});

test("every other failure keeps the generic copy", () => {
  for (const code of [undefined, "no_subscription", "no_workspace_customer"]) {
    assert.equal(
      billingPortalErrorCopy(code).titleKey,
      "settingsPage.account.billing.couldNotOpenTitle"
    );
  }
});
