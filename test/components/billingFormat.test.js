const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatBillingDate,
  translationParams,
} = require("../../src/components/settings/billing/billingFormat.ts");

test("formatBillingDate formats an ISO date in the reader's locale", () => {
  assert.equal(formatBillingDate("2026-12-20T12:00:00Z", "en"), "Dec 20, 2026");
});

test("formatBillingDate shows an unparseable string as it came, never Invalid Date", () => {
  assert.equal(formatBillingDate("not-a-date", "en"), "not-a-date");
  assert.equal(formatBillingDate("", "en"), "");
});

test("translationParams formats dates and turns days and count into a numeric count", () => {
  const formatDate = (iso) => `D(${iso})`;
  assert.equal(translationParams(undefined, formatDate), undefined);
  assert.deepEqual(translationParams({ date: "2026-12-20", plan: "Pro" }, formatDate), {
    date: "D(2026-12-20)",
    plan: "Pro",
  });
  assert.deepEqual(translationParams({ days: "5" }, formatDate), { days: "5", count: 5 });
  assert.deepEqual(translationParams({ count: "2" }, formatDate), { count: 2 });
});
