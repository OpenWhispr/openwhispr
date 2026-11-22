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

test("invoice presentation combines supplied values and keeps zero with or without its date", () => {
  const {
    formatBillingInvoice,
  } = require("../../src/components/settings/billing/billingFormat.ts");
  const date = "2026-12-20T12:00:00Z";
  assert.equal(
    formatBillingInvoice({ date, amount: 0, currency: "usd" }, "en"),
    "Dec 20, 2026 · $0.00"
  );
  assert.equal(formatBillingInvoice({ date: null, amount: 0, currency: "usd" }, "en"), "$0.00");
  assert.equal(formatBillingInvoice({ date }, "en"), "Dec 20, 2026");
  assert.equal(formatBillingInvoice({ amount: 1200 }, "en"), "");
});

test("a yen invoice displays the full amount returned by Stripe", () => {
  const {
    formatBillingInvoice,
  } = require("../../src/components/settings/billing/billingFormat.ts");
  assert.equal(
    formatBillingInvoice({ amount: 2000, currency: "jpy" }, "ja"),
    (2000).toLocaleString(undefined, { style: "currency", currency: "JPY" })
  );
});
