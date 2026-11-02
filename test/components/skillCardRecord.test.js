const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/chat/skillCardRecord.ts");

const RECORD = {
  status: "saved",
  kind: "update",
  name: "weekly-recap",
  title: "Weekly recap",
  versionId: "1760950800000",
  message: "Updated the weekly-recap skill.",
};
const call = (name, metadata, args = "{}") => ({
  id: "call-1",
  name,
  arguments: args,
  status: "completed",
  ...(metadata ? { metadata } : {}),
});

test("a saved skill card's record is read back from its call", async () => {
  const { readSkillCardRecord } = await load();

  assert.deepEqual(readSkillCardRecord(call("update_skill", RECORD)), RECORD);
  const { versionId: _versionId, ...created } = { ...RECORD, kind: "create" };
  assert.deepEqual(readSkillCardRecord(call("propose_skill", created)), created);
});

test("a call that showed no card, or a malformed record, reads as none", async () => {
  const { readSkillCardRecord } = await load();

  assert.equal(readSkillCardRecord(call("propose_skill")), null, "problems went back to the model");
  assert.equal(readSkillCardRecord(call("load_skill", RECORD)), null, "not a card tool");
  assert.equal(readSkillCardRecord(call("update_skill", [RECORD])), null);
  for (const broken of [
    { ...RECORD, status: "sent" },
    { ...RECORD, kind: "delete" },
    { ...RECORD, name: "" },
    { ...RECORD, title: 7 },
    { ...RECORD, versionId: 5 },
  ]) {
    assert.equal(readSkillCardRecord(call("update_skill", broken)), null, JSON.stringify(broken));
  }
});

test("a saved chat keeps no proposed skill text, and every other call as it was", async () => {
  const { withoutSkillCardDrafts } = await load();
  const draft = JSON.stringify({
    title: "Weekly recap",
    instructions: "## Steps\nThe whole skill.",
    files: [{ path: "references/style.md", content: "Private style notes" }],
  });
  const search = call("search_notes", undefined, JSON.stringify({ query: "recap" }));

  const saved = withoutSkillCardDrafts([
    call("propose_skill", RECORD, draft),
    call("update_skill", RECORD, draft),
    search,
  ]);

  assert.deepEqual(
    saved.map((entry) => entry.arguments),
    ["{}", "{}", search.arguments]
  );
  assert.deepEqual(saved[0].metadata, RECORD, "the outcome stays");
  assert.equal(saved[2], search);
});
