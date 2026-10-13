const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");

const sharedPaths = new Set([
  ".github/workflows/ci-changes.yml",
  ".github/workflows/codeql.yml",
  ".github/dependabot.yml",
  ".gitattributes",
]);

/** @param {string[]} paths @returns {{desktop: boolean, mobile: boolean, build: boolean}} */
function classifyPaths(paths) {
  let desktop = false;
  let mobile = false;
  let build = false;
  for (const path of paths) {
    if (sharedPaths.has(path) || path.startsWith(".github/scripts/")) {
      desktop = true;
      mobile = true;
      build = true;
    } else if (
      path.startsWith("openwhispr-mobile/") ||
      path === ".github/workflows/mobile-ci.yml"
    ) {
      mobile = true;
    } else {
      desktop = true;
      if (
        !path.endsWith(".md") &&
        path !== "LICENSE" &&
        !path.startsWith(".github/ISSUE_TEMPLATE/")
      ) {
        build = true;
      }
    }
  }
  return { desktop, mobile, build };
}

/** @param {string} eventName @param {{before?: string}} event @returns {string | null} */
function diffBase(eventName, event) {
  // On pull_request, HEAD is GitHub's test merge; its first parent is the base.
  if (eventName === "pull_request") return "HEAD^1";
  if (
    eventName === "push" &&
    /^[a-f0-9]{40}$/.test(event.before || "") &&
    !/^0+$/.test(event.before)
  ) {
    return event.before;
  }
  return null;
}

/** @returns {void} */
function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = diffBase(process.env.GITHUB_EVENT_NAME, event);
  let scope = { desktop: true, mobile: true, build: true };
  if (base) {
    try {
      // Disabling rename detection includes both sides of moves between apps.
      const paths = execFileSync(
        "git",
        ["diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"],
        {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      scope = classifyPaths(paths.split("\0").filter(Boolean));
    } catch {
      // A missing force-push base must not silently skip validation.
      console.warn("Unable to determine changed paths; running both applications' checks.");
    }
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(scope)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("")
  );
}

module.exports = { classifyPaths, diffBase };
if (require.main === module) main();
