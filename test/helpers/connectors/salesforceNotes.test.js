const test = require("node:test");
const assert = require("node:assert/strict");

test("Salesforce source reads reject mismatched accounts, deleted notes, and invalid identifiers", async () => {
  const { createSalesforceNoteReader } =
    await import("../../../src/helpers/connectors/salesforceNotes.js");
  const calls = [];
  const database = {
    activeAccountId: "a",
    getNote(id) {
      calls.push(id);
      return { id, title: "Call", deleted_at: id === 2 ? "today" : null };
    },
  };
  let account = "a";
  const read = createSalesforceNoteReader({ database, getAccountId: () => account });
  assert.equal(read(1, "a").title, "Call");
  assert.equal(read(2, "a"), null);
  for (const id of [0, -1, 1.2, "1", NaN]) assert.equal(read(id, "a"), null);
  assert.equal(read(1, "b"), null);
  account = "b";
  assert.equal(read(1, "b"), null);
  account = null;
  assert.equal(read(1, null), null);
  assert.deepEqual(calls, [1, 2]);
});
