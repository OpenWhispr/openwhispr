const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = () =>
  fs.readFileSync(path.join(__dirname, "../..", "src/services/SyncService.ts"), "utf8");

// Pinned at the source level because the pass accounting hangs off ordering and
// field ownership inside one private method, which no unit test can reach.
test("an analytics push records its own work and never writes the team flag", () => {
  const body = source().match(/private async syncAnalytics\(\)([\s\S]*?)\n {2}}/);
  assert.ok(body, "syncAnalytics is present");
  assert.ok(
    body[1].includes("this.analyticsPassMovedWork = true"),
    "a counter upload must record itself as pass work"
  );
  assert.equal(
    body[1].includes("teamPassMovedWork"),
    false,
    "teamPassMovedWork means team or shared content moved; overloading it pins " +
      "every backup-off Insights account to the 5-minute ambient cadence"
  );
});

test("the empty-streak stamp is taken after analytics has had its chance to move work", () => {
  const pass = source().match(/async syncAll\(waitForLock = false\)([\s\S]*?)\n {2}}/);
  assert.ok(pass, "syncAll is present");
  const analyticsAt = pass[1].indexOf("this.syncAnalytics()");
  const stampAt = pass[1].indexOf("this.recordTeamOnlyPass()");
  assert.ok(analyticsAt !== -1 && stampAt !== -1, "both calls are present in the pass");
  assert.ok(
    stampAt > analyticsAt,
    "stamping the streak before syncAnalytics runs makes the analytics signal land " +
      "a pass late, so the fix silently stops working"
  );
});
