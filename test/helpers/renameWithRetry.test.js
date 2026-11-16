const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { renameWithRetry } = require("../../src/helpers/renameWithRetry");

function onWindows(t) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
}

function refusedOnce(t) {
  const realRename = fs.renameSync;
  let refused = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!refused) {
      refused = true;
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return realRename(from, to);
  });
}

function caseInsensitiveFileSystem() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "OpenWhisprCaseProbe-"));
  try {
    return fs.existsSync(probe.toLowerCase()) && fs.existsSync(probe.toUpperCase());
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

test(
  "on Windows, a rename that only changes case is tried again when refused",
  { skip: !caseInsensitiveFileSystem() && "needs a case-insensitive file system" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-rename-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "work"));
    onWindows(t);
    refusedOnce(t);

    renameWithRetry(path.join(dir, "work"), path.join(dir, "Work"));
    t.mock.restoreAll();

    assert.deepEqual(fs.readdirSync(dir), ["Work"]);
  }
);

test("on Windows, a refused rename onto another existing file isn't tried again", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-rename-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.md"), "a");
  fs.writeFileSync(path.join(dir, "b.md"), "b");
  onWindows(t);
  refusedOnce(t);

  assert.throws(() => renameWithRetry(path.join(dir, "a.md"), path.join(dir, "b.md")), {
    code: "EBUSY",
  });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(dir, "b.md"), "utf8"), "b");
});
