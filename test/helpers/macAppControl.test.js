const test = require("node:test");
const assert = require("node:assert/strict");

const { usesAppControlPicker } = require("../../src/helpers/macAppControl");

test("the app picker starts at macOS 27.3", () => {
  for (const version of ["27.3", "27.3.0", "27.3.1", "27.10", "28.0"]) {
    assert.equal(usesAppControlPicker(version), true, version);
  }
  for (const version of ["27.2", "27.2.9", "27", "26.6.2", "", undefined]) {
    assert.equal(usesAppControlPicker(version), false, String(version));
  }
});
