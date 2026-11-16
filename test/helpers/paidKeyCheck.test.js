const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPaidKeyCheck } = require("../../src/helpers/paidKeyCheck");
const { deferred } = require("./harness/deferred");

function scratchFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paid-key-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "paid-key-checks.json");
}

function countingCheck(result) {
  const check = async () => {
    check.runs += 1;
    return result;
  };
  check.runs = 0;
  return check;
}

test("a key that passed is never checked again, even after a restart", async (t) => {
  const file = scratchFile(t);
  const check = countingCheck({ success: true });
  const runPaidCheck = createPaidKeyCheck(() => file);
  assert.deepEqual(await runPaidCheck("tf-key", check), { success: true });
  assert.deepEqual(await runPaidCheck("tf-key", check), { success: true });
  assert.deepEqual(await createPaidKeyCheck(() => file)("tf-key", check), { success: true });
  assert.equal(check.runs, 1);

  await runPaidCheck("tf-other", check);
  assert.equal(check.runs, 2, "each key is paid for once");
});

test("only the key's digest is stored", async (t) => {
  const file = scratchFile(t);
  await createPaidKeyCheck(() => file)("tf-secret-key", countingCheck({ success: true }));
  const stored = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(stored, /tf-secret-key/);
  assert.match(JSON.parse(stored).passed[0], /^[0-9a-f]{64}$/);
});

test("a key that did not pass is asked about again", async (t) => {
  for (const result of [
    { success: false, errorCode: "credentialsRejected", status: 401 },
    { success: false, errorCode: "timeout", unverified: true },
  ]) {
    const file = scratchFile(t);
    const check = countingCheck(result);
    const runPaidCheck = createPaidKeyCheck(() => file);
    assert.deepEqual(await runPaidCheck("tf-key", check), result);
    assert.deepEqual(await runPaidCheck("tf-key", check), result);
    assert.equal(check.runs, 2, result.errorCode);
    assert.equal(fs.existsSync(file), false, result.errorCode);
  }
});

test("checks for one key share a request while it runs", async (t) => {
  const file = scratchFile(t);
  const runPaidCheck = createPaidKeyCheck(() => file);
  const answer = deferred();
  let runs = 0;
  const check = () => {
    runs += 1;
    return answer.promise;
  };
  const first = runPaidCheck("tf-key", check);
  const second = runPaidCheck("tf-key", check);
  answer.resolve({ success: true });
  assert.deepEqual(await Promise.all([first, second]), [{ success: true }, { success: true }]);
  assert.equal(runs, 1);
});

test("an unreadable or unwritable file only costs another check", async (t) => {
  const file = scratchFile(t);
  fs.writeFileSync(file, "not json");
  const check = countingCheck({ success: true });
  await createPaidKeyCheck(() => file)("tf-key", check);
  assert.equal(check.runs, 1);

  // The directory's own path cannot be written as a file; the key is still remembered here.
  const unwritable = createPaidKeyCheck(() => path.dirname(file));
  await unwritable("tf-key", check);
  await unwritable("tf-key", check);
  assert.equal(check.runs, 2);
});
