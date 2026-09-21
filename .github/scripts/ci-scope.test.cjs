const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyPaths, diffBase } = require("./ci-scope.cjs");

test("desktop source and dependency changes only select desktop", () => {
  assert.deepEqual(classifyPaths(["src/main.ts", "package-lock.json", ".nvmrc"]), {
    desktop: true,
    mobile: false,
    build: true,
  });
});

test("mobile source, dependencies, docs and workflow only select mobile", () => {
  for (const path of [
    "openwhispr-mobile/app/index.tsx",
    "openwhispr-mobile/package-lock.json",
    "openwhispr-mobile/README.md",
    ".github/workflows/mobile-ci.yml",
  ]) {
    assert.deepEqual(classifyPaths([path]), { desktop: false, mobile: true, build: false });
  }
});

test("mixed changes and cross-app renames select both", () => {
  assert.deepEqual(classifyPaths(["src/old.ts", "openwhispr-mobile/src/new.ts"]), {
    desktop: true,
    mobile: true,
    build: true,
  });
});

test("shared CI configuration selects both", () => {
  for (const path of [
    ".github/workflows/ci-changes.yml",
    ".github/workflows/codeql.yml",
    ".github/scripts/ci-scope.cjs",
    ".github/dependabot.yml",
    ".gitattributes",
  ]) {
    assert.deepEqual(classifyPaths([path]), { desktop: true, mobile: true, build: true });
  }
});

test("desktop docs do not require packaging", () => {
  assert.deepEqual(
    classifyPaths(["README.md", "docs/setup.md", "LICENSE", ".github/ISSUE_TEMPLATE/bug.yml"]),
    {
      desktop: true,
      mobile: false,
      build: false,
    }
  );
});

test("desktop workflows do not select mobile", () => {
  assert.deepEqual(
    classifyPaths([
      ".github/workflows/build-and-notarize.yml",
      ".github/workflows/lockfile-lint.yml",
    ]),
    {
      desktop: true,
      mobile: false,
      build: true,
    }
  );
});

test("handles large diffs and unusual file names without truncation", () => {
  const paths = Array.from({ length: 500 }, (_, index) => `openwhispr-mobile/src/file-${index}.ts`);
  paths.push("src/file with\na newline.ts");
  assert.deepEqual(classifyPaths(paths), { desktop: true, mobile: true, build: true });
});

test("empty diff selects neither app", () => {
  assert.deepEqual(classifyPaths([]), { desktop: false, mobile: false, build: false });
});

test("PRs compare against the merge parent and pushes cover every pushed commit", () => {
  const before = "a".repeat(40);
  assert.equal(diffBase("pull_request", {}), "HEAD^1");
  assert.equal(diffBase("push", { before }), before);
  assert.equal(diffBase("push", { before: "0".repeat(40) }), null);
  assert.equal(diffBase("push", { before: "--invalid" }), null);
  assert.equal(diffBase("workflow_dispatch", {}), null);
  assert.equal(diffBase("schedule", {}), null);
});
