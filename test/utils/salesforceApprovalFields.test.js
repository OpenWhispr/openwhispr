const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../../src/utils/salesforceApprovalFields.ts");
const definitions = [
  { key: "value0", name: "Needs__c", label: "Needs", before: "Old", maxLength: 4 },
];
test("field approval blocks no selected changes and overlength edits", async () => {
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
});

test("Copy on a field card takes each included field's label and new value", async () => {
  const { salesforceFieldsCopyText } = await load();
  const two = [
    ...definitions,
    { key: "value1", name: "Risks__c", label: "Risks", before: "", maxLength: 50 },
  ];
  assert.equal(
    salesforceFieldsCopyText(two, {
      value0: "Pilot",
      include0: "yes",
      value1: "Budget",
      include1: "yes",
    }),
    "Needs: Pilot\n\nRisks: Budget"
  );
  assert.equal(
    salesforceFieldsCopyText(two, { value0: "Pilot", include0: "no", value1: "", include1: "yes" }),
    "Risks: "
  );
  assert.equal(salesforceFieldsCopyText(undefined, undefined), "");
});
