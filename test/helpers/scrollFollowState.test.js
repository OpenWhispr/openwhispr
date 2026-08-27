const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/scrollFollowState.ts");

test("resize measurements cannot re-pin after explicit upward scroll intent", async () => {
  const { createScrollFollowController } = await load();
  const follower = createScrollFollowController({ nearBottomThreshold: 80 });

  assert.equal(
    follower.update({ scrollHeight: 1000, scrollTop: 680, clientHeight: 300 }),
    true,
    "the initial near-bottom position follows live content"
  );

  follower.leaveBottom();
  assert.equal(
    follower.update({ scrollHeight: 1020, scrollTop: 680, clientHeight: 300 }),
    false,
    "a resize-driven height change preserves the reader's upward intent"
  );
  assert.equal(
    follower.update({ scrollHeight: 990, scrollTop: 680, clientHeight: 300 }),
    false,
    "being back inside the old near-bottom threshold does not re-pin"
  );

  assert.equal(
    follower.update({ scrollHeight: 980, scrollTop: 680, clientHeight: 300 }),
    true,
    "follow mode returns only at the true bottom"
  );
});
