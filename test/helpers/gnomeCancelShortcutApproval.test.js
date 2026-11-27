const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cancel-approval-"));
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userData } },
};
delete require.cache[require.resolve("../../src/helpers/gnomeCancelShortcutApproval")];
const approval = require("../../src/helpers/gnomeCancelShortcutApproval");

test("the GNOME cancel approval survives a restart and can be cleared", () => {
  assert.equal(approval.read(), null);

  approval.write("approved");
  assert.equal(approval.read(), "approved");
  approval.write("declined");
  assert.equal(approval.read(), "declined");

  approval.write(null);
  assert.equal(approval.read(), null);
  approval.write(null);
  assert.equal(approval.read(), null);
});

test("an unreadable GNOME cancel approval reads as not yet asked", () => {
  fs.writeFileSync(path.join(userData, ".gnome-cancel-shortcut-approval"), "maybe");
  assert.equal(approval.read(), null);
});
