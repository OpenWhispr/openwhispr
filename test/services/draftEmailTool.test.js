const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/draftEmailTool.ts");

test("draft_email returns the draft as metadata-ready data without sending", async () => {
  const { createDraftEmailTool } = await load();
  const tool = createDraftEmailTool("me@example.com");

  const result = await tool.execute({
    to: ["a@example.com"],
    cc: ["b@example.com"],
    subject: "Follow-up",
    body: "Thanks for the meeting.",
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    to: ["a@example.com"],
    cc: ["b@example.com"],
    subject: "Follow-up",
    body: "Thanks for the meeting.",
    from: "me@example.com",
    status: "draft",
  });
  assert.equal(result.displayText, 'Drafted email: "Follow-up"');
});

test("draft_email allows empty recipients so the user can fill them in", async () => {
  const { createDraftEmailTool } = await load();
  const tool = createDraftEmailTool("me@example.com");

  const result = await tool.execute({ subject: "s", body: "b" });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.to, []);
});

test("draft_email rejects invalid recipient addresses", async () => {
  const { createDraftEmailTool } = await load();
  const tool = createDraftEmailTool("me@example.com");

  const result = await tool.execute({
    to: ["not-an-email"],
    subject: "s",
    body: "b",
  });
  assert.equal(result.success, false);
  assert.match(result.displayText, /not-an-email/);
});
