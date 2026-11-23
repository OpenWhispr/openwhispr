const test = require("node:test");
const assert = require("node:assert/strict");
const {
  seatNoticeBillingTarget,
} = require("../../src/components/notes/seatNoticeBillingTarget.ts");

const ID = "0b5e6f0e-5c1a-4f5e-9d3b-2a1c7e8f9a10";

test("the seat notice opens its workspace's plan, or Personal without one", () => {
  assert.equal(seatNoticeBillingTarget({ id: ID }), `plansBilling:workspace:${ID}`);
  assert.equal(seatNoticeBillingTarget(null), "plansBilling");
  assert.equal(seatNoticeBillingTarget(undefined), "plansBilling");
});
