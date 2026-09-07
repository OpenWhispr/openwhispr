const assert = require("node:assert/strict");
const test = require("node:test");

const {
  qaUserDataDirectoryName,
  qaWindowTitle,
  resolveQaProfile,
} = require("../../src/helpers/qaProfile");

test("QA profiles are development-only and reject path-like values", () => {
  assert.equal(resolveQaProfile("Business-Owner", "development"), "business-owner");
  assert.equal(resolveQaProfile("../shared", "development"), null);
  assert.equal(resolveQaProfile("business-owner", "production"), null);
});

test("QA profiles isolate user data and label windows", () => {
  assert.equal(
    qaUserDataDirectoryName("development", "free-domain"),
    "OpenWhispr-development-free-domain"
  );
  assert.equal(qaUserDataDirectoryName("development", null), "OpenWhispr-development");
  assert.equal(qaWindowTitle("OpenWhispr", "pro-solo"), "OpenWhispr — pro-solo");
  assert.equal(qaWindowTitle("OpenWhispr", null), "OpenWhispr");
});
