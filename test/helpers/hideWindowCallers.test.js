// Fix round 1, finding 2: Task 9 turned hide-window into a REJECTING channel
// (main refuses when an open or busy Assistant panel owns the window, and the
// handler throws rather than resolving a hide that never happened). The
// renderer installs no `unhandledrejection` handler, so every caller has to
// deal with the rejection itself. This sweeps them all: a NEW call site that
// neither catches nor is awaited inside a try fails here rather than becoming
// an unhandled rejection someone inherits later.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = path.resolve(__dirname, "../..");
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
// Built output, not source — it carries a bundled copy of every call site.
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...collectSourceFiles(path.join(directory, entry.name)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

// Call sites only: `electronAPI.hideWindow()` / `electronAPI?.hideWindow?.()`.
// The type declaration and the handoff's own `hideWindow?: () => …` parameter
// are not calls through the bridge and are not matched.
const CALL_SITE = /electronAPI\??\.hideWindow\??\.?\(\)/;

function callSites() {
  const found = [];
  for (const file of collectSourceFiles(path.join(sourceRoot, "src"))) {
    const relative = path.relative(sourceRoot, file);
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (CALL_SITE.test(line)) found.push({ file: relative, line: index + 1, text: line });
      });
  }
  return found;
}

test("every renderer call site of the rejecting hide-window bridge is accounted for", () => {
  const sites = callSites();
  assert.deepEqual(
    sites.map((site) => site.file).sort(),
    [
      "src/AppRouter.jsx",
      "src/hooks/useMainWindowSizeOwner.js",
      "src/hooks/usePillExitChoreography.js",
    ],
    "a new hide-window call site must be swept for rejection handling and listed here"
  );
});

test("AppRouter's fire-and-forget hide carries its own rejection handler", () => {
  const site = callSites().find((candidate) => candidate.file === "src/AppRouter.jsx");
  assert.ok(site, "expected AppRouter to still hide the overlay during onboarding");
  // Nothing awaits this one — it is a statement inside an effect — so the
  // rejection has nowhere else to land.
  assert.match(
    site.text,
    /\.catch\(/,
    "a floating hide-window call would surface as an unhandled rejection"
  );
});

test("the exit choreography's hide is awaited inside its own try/catch", () => {
  const site = callSites().find(
    (candidate) => candidate.file === "src/hooks/usePillExitChoreography.js"
  );
  assert.ok(site);
  assert.match(site.text, /^\s*await /);
  // The catch's actual BEHAVIOUR (the pill comes back rather than sitting
  // collapsed on a window nothing will hide) is proven by
  // usePillExitChoreography.test.js's "a refused or unhandled hide…" test;
  // this only pins that the call is inside a handler at all.
  const source = fs.readFileSync(
    path.join(sourceRoot, "src/hooks/usePillExitChoreography.js"),
    "utf8"
  );
  assert.match(source, /try \{[\s\S]*electronAPI\?\.hideWindow\?\.\(\)[\s\S]*\} catch \{/);
});

test("the size owner's hide is a thunk the error handoff awaits inside a try", () => {
  const site = callSites().find(
    (candidate) => candidate.file === "src/hooks/useMainWindowSizeOwner.js"
  );
  assert.ok(site);
  assert.match(site.text, /hideWindow: \(\) =>/, "it is passed as a thunk, not called here");
  const owner = fs.readFileSync(
    path.join(sourceRoot, "src/hooks/useMainWindowSizeOwner.js"),
    "utf8"
  );
  assert.match(owner, /createDictationErrorPillHandoff\(\{[\s\S]*hideWindow:/);
  const handoff = fs.readFileSync(
    path.join(sourceRoot, "src/utils/dictationErrorPillHandoff.ts"),
    "utf8"
  );
  assert.match(handoff, /try \{[\s\S]*await hideWindow\(\);[\s\S]*\} catch \{/);
});
