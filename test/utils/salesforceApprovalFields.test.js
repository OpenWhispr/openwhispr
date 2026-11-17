const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../../src/utils/salesforceApprovalFields.ts");
const definitions = [
  { key: "value0", name: "Needs__c", label: "Needs", before: "Old", maxLength: 4 },
];
test("field approval blocks malformed previews, no selected changes and overlength edits", async () => {
  const { salesforceFieldProblem } = await load();
  assert.equal(salesforceFieldProblem(definitions, { value0: "New", include0: "yes" }), null);
  assert.equal(salesforceFieldProblem(definitions, { value0: "😀😀", include0: "yes" }), null);
  assert.equal(
    salesforceFieldProblem(definitions, { value0: "😀😀😀", include0: "yes" }),
    "tooLong",
    "UTF-16 limits match the main-process write validation"
  );
  assert.equal(
    salesforceFieldProblem(definitions, { value0: "12345", include0: "yes" }),
    "tooLong"
  );
  assert.equal(
    salesforceFieldProblem(definitions, { value0: "12345", include0: "no" }),
    "noneSelected"
  );
  assert.equal(
    salesforceFieldProblem(definitions, { value0: "", include0: "yes" }),
    null,
    "explicit clearing is allowed"
  );
  assert.equal(salesforceFieldProblem(undefined, {}), "invalidPreview");
  assert.equal(
    salesforceFieldProblem(definitions, { value0: ["hidden"], include0: "yes" }),
    "invalidPreview"
  );
  assert.equal(
    salesforceFieldProblem(definitions, { value0: "New", include0: "yes", value1: "hidden" }),
    "invalidPreview"
  );
});
