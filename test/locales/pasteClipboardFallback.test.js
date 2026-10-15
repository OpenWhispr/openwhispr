const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../../src/locales");

test("all locales explain clipboard fallback with a manual shortcut and a persistent opt-out", () => {
  for (const locale of fs.readdirSync(root)) {
    const file = path.join(root, locale, "translation.json");
    if (!fs.existsSync(file)) continue;
    const copy = JSON.parse(fs.readFileSync(file, "utf8")).hooks.audioRecording.pastePermission;
    for (const key of ["copiedTitle", "copiedDescription", "dontShowAgain"]) {
      assert.equal(typeof copy[key], "string", `${locale}: ${key}`);
      assert.ok(copy[key].trim(), `${locale}: ${key} cannot be blank`);
    }
    assert.match(copy.copiedDescription, /{{shortcut}}/, locale);
  }
});
