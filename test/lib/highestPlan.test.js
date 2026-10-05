const test = require("node:test");
const assert = require("node:assert/strict");

const { highestPlan } = require("../../src/lib/usageStore.ts");

test("the best tier a covering workspace grants wins", () => {
  assert.equal(highestPlan(["free", "business"]), "business");
  assert.equal(highestPlan(["pro", "enterprise", "business"]), "enterprise");
  assert.equal(highestPlan(["pro", "pro"]), "pro");
});

test("nothing to rank falls back to free", () => {
  assert.equal(highestPlan([]), "free");
  assert.equal(highestPlan(["free"]), "free");
});

test("an unrecognized tier never out-ranks a known paid one", () => {
  assert.equal(highestPlan(["mystery"]), "free");
  assert.equal(highestPlan(["mystery", "pro"]), "pro");
});
