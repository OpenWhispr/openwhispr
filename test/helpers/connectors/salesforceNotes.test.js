const test = require("node:test");
const assert = require("node:assert/strict");

test("Salesforce source reads reject mismatched accounts", async () => {
  const { createSalesforceNoteReader } =
    await import("../../../src/helpers/connectors/salesforceNotes.js");
  const calls = [];
  const database = {
    activeAccountId: "a",
    getNote(id) {
      calls.push(id);
      return { id, title: "Call" };
    },
  };
  let account = "a";
  const read = createSalesforceNoteReader({ database, getAccountId: () => account });
  assert.equal(read(1, "a").title, "Call");
  assert.equal(read(1, "b"), null);
  account = "b";
  assert.equal(read(1, "b"), null);
  account = null;
  assert.equal(read(1, null), null);
  assert.deepEqual(calls, [1]);
});
