// Fork CI guard: a fork build with no repository variables must be cloud-disabled, and
// jobs that only make sense upstream (releases, store submissions, canaries against the
// hosted cloud) must not run in the fork. See .planning/REQUIREMENTS.md CI-01, CI-02.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOWS = path.join(__dirname, "..", "..", ".github", "workflows");
const UPSTREAM_GUARD = "github.repository == 'OpenWhispr/openwhispr'";
const HOSTED = /https?:\/\/[a-z0-9.-]*(openwhispr\.com|gizmovoice\.ai|gizmolabs\.)/i;

const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

// Top-level job headers ("  name:" at two-space indent under jobs:) and their `if:` line.
function jobConditions(source) {
  const jobsAt = source.indexOf("\njobs:");
  assert.ok(jobsAt >= 0, "workflow has a jobs block");
  const lines = source.slice(jobsAt).split("\n");
  const jobs = {};
  let current = null;
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs[current] = null;
      continue;
    }
    const cond = /^ {4}if:\s*(.+)$/.exec(line);
    if (current && cond && jobs[current] === null) jobs[current] = cond[1];
  }
  return jobs;
}

test("no workflow defaults a build variable to an OpenWhispr-hosted URL", () => {
  for (const name of fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    for (const line of read(name).split("\n")) {
      if (/\|\|/.test(line) && /\$\{\{/.test(line)) {
        assert.doesNotMatch(line, HOSTED, `${name}: hosted fallback in "${line.trim()}"`);
      }
    }
  }
});

const UPSTREAM_ONLY = {
  "release.yml": ["tests", "build-linux", "build-windows", "build-macos"],
  "update-winget.yml": ["update-winget"],
  "update-nix.yml": ["update-nix"],
  "llm-canary.yml": ["canary"],
  "stt-canary.yml": ["canary"],
  "build-and-notarize.yml": ["build-linux", "build-macos"],
  "mobile-ci.yml": ["changes", "lockfile", "checks", "native-transport", "mobile-status"],
};

for (const [file, jobs] of Object.entries(UPSTREAM_ONLY)) {
  test(`${file}: upstream-only jobs are guarded to OpenWhispr/openwhispr`, () => {
    const conditions = jobConditions(read(file));
    for (const job of jobs) {
      assert.ok(job in conditions, `${file} has job ${job}`);
      assert.ok(
        conditions[job] && conditions[job].startsWith(UPSTREAM_GUARD),
        `${file}:${job} must start its if: with the upstream guard (got ${conditions[job]})`
      );
    }
  });
}

test("build-and-notarize: the Windows build still runs in the fork", () => {
  const conditions = jobConditions(read("build-and-notarize.yml"));
  assert.ok(!String(conditions["build-windows"]).includes(UPSTREAM_GUARD));
});
