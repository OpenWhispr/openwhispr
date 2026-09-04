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

test("a pin echo at the bottom right after leaveBottom does not restore follow", async () => {
  const { createScrollFollowController } = await load();
  const follower = createScrollFollowController({ nearBottomThreshold: 80 });

  // A programmatic pin issued before the wheel landed still fires its scroll
  // event after leaveBottom — at the bottom. Rejoining here would let the next
  // resize yank the reader, which is the exact race this controller exists for.
  follower.leaveBottom();
  assert.equal(
    follower.update({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }),
    false,
    "a bottom scroll echoing a pre-detach pin stays detached"
  );

  assert.equal(
    follower.update({ scrollHeight: 1000, scrollTop: 500, clientHeight: 300 }),
    false,
    "the reader genuinely moving away stays detached"
  );
  assert.equal(
    follower.update({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }),
    true,
    "only the reader's own return to the bottom rejoins"
  );
});
