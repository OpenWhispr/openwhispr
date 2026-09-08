const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const semanticWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/semantic-release.yml"),
  "utf8"
);
const testsWorkflow = fs.readFileSync(path.join(root, ".github/workflows/tests.yml"), "utf8");
const dependabotConfig = fs.readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
const allWorkflows = fs
  .readdirSync(path.join(root, ".github/workflows"))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => fs.readFileSync(path.join(root, ".github/workflows", file), "utf8"))
  .join("\n");
const releaseWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const releaseConfig = require("../../.github/semantic-release/release.config.cjs");
const { semanticReleaseEnvironment } = require("../../.github/semantic-release/run.cjs");
const toolingPackage = require("../../.github/semantic-release/package.json");
const applicationPackage = require("../../package.json");

function pluginOptions(name) {
  const entry = releaseConfig.plugins.find((plugin) =>
    Array.isArray(plugin) ? plugin[0] === name : plugin === name
  );
  return Array.isArray(entry) ? entry[1] : undefined;
}

test("semantic-release maps Conventional Commits into versioned draft releases", () => {
  assert.deepEqual(releaseConfig.branches, ["main"]);
  assert.equal(releaseConfig.tagFormat, "v${version}");
  assert.ok(releaseConfig.plugins.includes("@semantic-release/commit-analyzer"));
  assert.ok(releaseConfig.plugins.includes("@semantic-release/release-notes-generator"));
  assert.equal(pluginOptions("@semantic-release/changelog").changelogFile, "CHANGELOG.md");
  assert.match(pluginOptions("@semantic-release/changelog").changelogTitle, /## \[Unreleased\]$/);
  assert.equal(pluginOptions("@semantic-release/npm").npmPublish, false);
  assert.equal(pluginOptions("@semantic-release/github").draftRelease, true);
  assert.ok(pluginOptions("@semantic-release/git").assets.includes("CHANGELOG.md"));
  assert.doesNotMatch(pluginOptions("@semantic-release/git").message, /\[skip ci\]/);
});

test("semantic release tooling is pinned outside application dependencies", () => {
  assert.equal(applicationPackage.devDependencies?.["semantic-release"], undefined);
  assert.match(toolingPackage.dependencies["semantic-release"], /^\d+\.\d+\.\d+$/);
  assert.match(toolingPackage.dependencies["@semantic-release/changelog"], /^\d+\.\d+\.\d+$/);
  assert.match(toolingPackage.engines.node, /24/);
});

test("passing main tests dispatch the signed builder only after a semantic release", () => {
  assert.match(testsWorkflow, /push:\n\s+branches: \[main\]/);
  assert.match(testsWorkflow, /workflow_dispatch:/);
  assert.match(semanticWorkflow, /workflow_run:\n\s+workflows: \["Tests"\]/);
  assert.match(semanticWorkflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(semanticWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(semanticWorkflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(semanticWorkflow, /No Tests workflow run exists/);
  assert.match(semanticWorkflow, /contents: write/);
  assert.match(semanticWorkflow, /actions: write/);
  assert.match(semanticWorkflow, /pull-requests: write/);
  assert.match(semanticWorkflow, /semantic-release\/run-\$\{GITHUB_RUN_ID\}/);
  assert.match(semanticWorkflow, /node \.github\/semantic-release\/run\.cjs/);
  assert.match(semanticWorkflow, /secrets\.RELEASE_PR_TOKEN/);
  assert.match(semanticWorkflow, /RELEASE_PR_TOKEN is required/);
  assert.match(semanticWorkflow, /gh pr create/);
  assert.match(semanticWorkflow, /--event pull_request/);
  assert.doesNotMatch(semanticWorkflow, /gh workflow run tests\.yml --ref "\$RELEASE_BRANCH"/);
  assert.match(semanticWorkflow, /gh run watch "\$TEST_RUN_ID"/);
  assert.match(semanticWorkflow, /\.workflowName == "Tests"/);
  assert.match(semanticWorkflow, /Generated Tests run \$TEST_RUN_ID was not attached to release PR/);
  assert.match(semanticWorkflow, /gh pr merge "\$PR_NUMBER".*--auto --merge --delete-branch/);
  assert.match(semanticWorkflow, /Release PR #\$PR_NUMBER did not merge/);
  assert.match(semanticWorkflow, /git merge-base --is-ancestor "\$GENERATED_SHA" "\$MAIN_SHA"/);
  assert.match(semanticWorkflow, /Remove incomplete semantic release/);
  assert.match(semanticWorkflow, /gh release delete "\$RELEASE_TAG"/);
  assert.match(semanticWorkflow, /Close incomplete release pull request/);
  assert.match(semanticWorkflow, /Remove temporary release branch/);
  assert.match(semanticWorkflow, /steps\.result\.outputs\.released == 'true'/);
  assert.match(semanticWorkflow, /gh workflow run release\.yml/);
  assert.match(semanticWorkflow, /-f reuse_semantic_release=true/);
});

test("semantic-release sees the staging branch as the active GitHub ref", () => {
  const env = semanticReleaseEnvironment({
    GITHUB_REF: "refs/heads/main",
    SEMANTIC_RELEASE_BRANCH: "semantic-release/run-123-1",
  });

  assert.equal(env.GITHUB_REF, "refs/heads/semantic-release/run-123-1");
  assert.equal(env.SEMANTIC_RELEASE_BRANCH, "semantic-release/run-123-1");
  assert.throws(() => semanticReleaseEnvironment({}), /SEMANTIC_RELEASE_BRANCH is required/);
});

test("release dependencies and GitHub Actions receive weekly updates", () => {
  assert.match(dependabotConfig, /directory: "\/\.github\/semantic-release"/);
  assert.match(dependabotConfig, /package-ecosystem: "github-actions"/);
  assert.equal((dependabotConfig.match(/interval: "weekly"/g) || []).length, 3);
  assert.doesNotMatch(allWorkflows, /actions\/(?:checkout|setup-node)@v4/);
  assert.match(allWorkflows, /actions\/checkout@v7/);
  assert.match(allWorkflows, /actions\/setup-node@v7/);
});

test("the signed builder only reuses a matching semantic draft and tag", () => {
  assert.match(releaseWorkflow, /reuse_semantic_release:/);
  assert.match(releaseWorkflow, /must still be a draft before artifact publication/);
  assert.match(releaseWorkflow, /TAG_SHA.*GITHUB_SHA/s);
  assert.match(releaseWorkflow, /requires both an existing draft release and its matching tag/);
});

test("the release gate waits on a status check the Tests workflow actually reports", () => {
  // The gate looks up a check by job name. Upstream renamed that job once
  // already, which silently wedged every release: semantic-release waited
  // forever for a check that no longer existed, and no version shipped for
  // over a month. Tie the two together so a rename fails here instead.
  const gatedCheck = semanticWorkflow.match(
    /select\(\.name == "([^"]+)" and \.workflowName == "Tests"\)/
  );
  assert.ok(gatedCheck, "semantic-release must gate on a named Tests check");

  const jobNames = [...testsWorkflow.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match[1]);
  assert.ok(
    jobNames.includes(gatedCheck[1]),
    `semantic-release waits for "${gatedCheck[1]}", but tests.yml only defines: ${jobNames.join(", ")}`
  );
});
