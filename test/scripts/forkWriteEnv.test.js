const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "..", "..", "scripts", "fork-write-env.mjs");
const KEYS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MICROSOFT_CALENDAR_CLIENT_ID",
  "SLACK_CLIENT_ID",
  "LINEAR_CLIENT_ID",
];
const VALUES = {
  GOOGLE_CALENDAR_CLIENT_ID: "g-id-1234.apps.example",
  GOOGLE_CALENDAR_CLIENT_SECRET: "GOCSPX-secretvalue123",
  MICROSOFT_CALENDAR_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  SLACK_CLIENT_ID: "123.456",
  LINEAR_CLIENT_ID: "lin_client_abc",
};

function run(env, out) {
  const clean = { ...process.env };
  for (const key of KEYS) delete clean[key];
  return spawnSync(process.execPath, [script, "--out", out], {
    env: { ...clean, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("with all five keys it writes exactly those lines and prints key names only", (t) => {
  const dir = tmp(t);
  const out = run(VALUES, dir);
  assert.equal(out.status, 0, out.stderr);
  const lines = fs.readFileSync(path.join(dir, ".env"), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(
    lines,
    KEYS.map((key) => `${key}=${VALUES[key]}`)
  );
  for (const key of KEYS) assert.ok(out.stdout.includes(key), key);
  for (const value of Object.values(VALUES)) {
    assert.ok(!out.stdout.includes(value) && !out.stderr.includes(value), "no value is printed");
  }
});

test("a missing or empty key exits 1, names the key, writes no file, prints no value", (t) => {
  const dir = tmp(t);
  const env = { ...VALUES, SLACK_CLIENT_ID: "", LINEAR_CLIENT_ID: undefined };
  delete env.LINEAR_CLIENT_ID;
  const out = run(env, dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /SLACK_CLIENT_ID/);
  assert.match(out.stderr, /LINEAR_CLIENT_ID/);
  assert.doesNotMatch(out.stderr, /GOOGLE_CALENDAR_CLIENT_ID/);
  assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  for (const value of Object.values(VALUES)) assert.ok(!out.stderr.includes(value));
});

test("a value with a newline exits 1 and writes nothing", (t) => {
  const dir = tmp(t);
  const out = run({ ...VALUES, GOOGLE_CALENDAR_CLIENT_SECRET: "line1\nINJECTED=1" }, dir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /GOOGLE_CALENDAR_CLIENT_SECRET/);
  assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  assert.ok(!out.stderr.includes("INJECTED"));
});

test("other keys in an existing .env are kept and the five are replaced, not duplicated", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "OPENWHISPR_LOG_LEVEL=debug",
      "SLACK_CLIENT_ID=old",
      "# note",
      "LINEAR_CLIENT_ID=old2",
      "",
    ].join("\n")
  );
  const out = run(VALUES, dir);
  assert.equal(out.status, 0, out.stderr);
  const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(text, /^OPENWHISPR_LOG_LEVEL=debug$/m);
  assert.match(text, /^# note$/m);
  for (const key of KEYS) {
    assert.equal(text.match(new RegExp(`^${key}=`, "gm")).length, 1, key);
  }
  assert.doesNotMatch(text, /=old/);
});

test("--out without a directory exits 1", () => {
  const out = spawnSync(process.execPath, [script, "--out"], {
    env: { ...process.env, ...VALUES },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(out.status, 1);
});
