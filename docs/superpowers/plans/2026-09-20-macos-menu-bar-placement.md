# macOS Menu-Bar Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OpenWhispr's macOS tray a best-effort starting position near system icons while retaining later user-selected positions.

**Architecture:** Register a fallback AppKit preferred position before creating the macOS tray, then supply one stable lowercase UUID to Electron's existing tray constructor. Keep this small platform branch inside `TrayManager.createTray()` and catch registration failures locally so the normal tray remains available. Let AppKit's stored user position take precedence over the fallback on later launches.

**Tech Stack:** CommonJS JavaScript, Electron `41.10.5`, macOS AppKit through Electron's existing APIs, Node `24` test runner, existing ESLint/Prettier/TypeScript quality checks.

**Spec:** `docs/superpowers/specs/2026-09-20-macos-menu-bar-placement-design.md`

**Execution status (2026-09-21):** Implementation, independent deep review, and the separate repair stage are complete in [PR #2267](https://github.com/OpenWhispr/openwhispr/pull/2267). The tested code is at `937bec156283709d29506bbaf5c8c4aba756e2c8`. The focused suite passed 14/14; repository quality checks and the GitHub test step passed. GitHub's quality job failed only at the inherited dependency audit, so the PR is still draft and unmerged.

Josh launched the full macOS development build and reported “Nice it works” on 21 September. This records his successful visible dev-build check. It does not establish the specific Command-drag/two-relaunch sequence below or official-installer acceptance; those detailed checks remain unrecorded. The earlier real Electron component harness separately verified saved-position persistence across two relaunches.

The next requested task is to investigate whether a similar experience is feasible on Windows. That investigation needs its own platform evidence and scope; this completed macOS implementation plan does not authorize copying the AppKit preference to Windows.

## Global Constraints

- Apply the new placement behavior only when `process.platform === "darwin"`.
- Keep the macOS tray GUID exactly `eb809902-04b5-5b08-b12a-f81d6f27e185` across launches and future releases.
- Before constructing the macOS tray, register `NSStatusItem Preferred Position eb809902-04b5-5b08-b12a-f81d6f27e185` with the numeric fallback value `0` through `systemPreferences.registerDefaults()`.
- Never call `setUserDefault()`, `removeUserDefault()`, shell preference commands, or native positioning bridges to implement this feature.
- If default registration throws, log a warning and continue creating the macOS tray with the same stable GUID.
- Preserve Windows and Linux one-argument tray construction and all existing icon, menu, tooltip, click, and double-click behavior.
- Add no dependencies, native helpers, renderer changes, settings, permissions, or user-facing strings; leave `package.json` and `package-lock.json` unchanged.
- Use Node `24` and the lockfile's Electron `41.10.5` for validation.
- Treat initial placement as best effort; do not claim guaranteed Wi-Fi/Search adjacency or infer native persistence from mocks.
- Follow TDD: observe the expected regression-test failure before changing production code, then run the focused tests and required quality checks.

## Execution ownership and files

Work in `/Users/joshuadavidpadoa/dev/openwhispr-menu-bar-placement-20260920` on `feat/macos-menu-bar-placement`. Read the spec, applicable repository instructions, and the TDD and code-quality skills before implementation. The user has already chosen sequential agents: the parent owns dispatch to the implementation agent, deep-review agent, and separate fix agent. Do not ask for an execution-mode choice or dispatch another planning agent.

The only production file is `src/helpers/tray.js`, which already owns native tray creation and its menu. Add one test file for its Electron boundary, `test/helpers/trayPlacement.test.js`. Keep the spec and this plan with the change. No abstraction, exported constant, configuration layer, or package change is needed.

---

### Task 1: Default macOS tray placement with stable position identity

**Files:**

- Modify: `src/helpers/tray.js:1` for the Electron import and private constants.
- Modify: `src/helpers/tray.js:133` for the platform-specific construction branch.
- Create/test: `test/helpers/trayPlacement.test.js`.
- Preserve: `test/helpers/trayQuickActions.test.js`, `test/helpers/trayActionPolicy.test.js`, and `test/helpers/dockPolicy.test.js`.

**Interfaces:**

- Consumes: `TrayManager.createTray(): Promise<void>`, the existing `loadTrayIcon()` result, Electron `new Tray(image, guid?)`, and `systemPreferences.registerDefaults(defaults): void`.
- Produces: the existing `TrayManager.tray` instance; on macOS its UUID is always `eb809902-04b5-5b08-b12a-f81d6f27e185`.
- Preserves: the exported `TrayManager` class and all existing public methods; no new exports.

- [x] **Step 1: Add the failing boundary regression tests**

Create `test/helpers/trayPlacement.test.js` with the following complete content. The VM loads the entire existing module and isolates the platform value without changing global Node state. Only native APIs, logging, and translation dependencies are stubbed. The image loader is replaced with a known valid image so these tests focus on tray construction; real menu creation and event wiring still run.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const POSITION_KEY = `NSStatusItem Preferred Position ${TRAY_GUID}`;
const trayPath = path.join(__dirname, "../../src/helpers/tray.js");
const traySource = fs.readFileSync(trayPath, "utf8");

function loadTrayManager(platform, { registrationError } = {}) {
  const calls = [];
  const registrations = [];
  const preferenceWrites = [];
  const warnings = [];
  const errors = [];
  const instances = [];
  const icon = { isEmpty: () => false };
  const electron = {
    Tray: class FakeTray {
      constructor(...args) {
        calls.push("construct");
        this.args = args;
        this.listeners = new Map();
        this.ignoreDoubleClickCalls = [];
        instances.push(this);
      }
      setIgnoreDoubleClickEvents(value) {
        this.ignoreDoubleClickCalls.push(value);
      }
      setToolTip(value) {
        this.tooltip = value;
      }
      setContextMenu(value) {
        this.menu = value;
      }
      on(event, listener) {
        this.listeners.set(event, listener);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    nativeImage: {},
    app: {},
    systemPreferences: {
      registerDefaults(defaults) {
        calls.push("register");
        registrations.push({ ...defaults });
        if (registrationError) throw registrationError;
      },
      setUserDefault(...args) {
        preferenceWrites.push(["set", ...args]);
      },
      removeUserDefault(...args) {
        preferenceWrites.push(["remove", ...args]);
      },
    },
  };
  const logger = {
    info() {},
    debug() {},
    warn: (...args) => warnings.push(args),
    error: (...args) => errors.push(args),
  };
  const loadedModule = { exports: {} };
  vm.runInNewContext(traySource, {
    module: loadedModule,
    __dirname: path.dirname(trayPath),
    process: { platform, env: {} },
    require(specifier) {
      if (specifier === "electron") return electron;
      if (specifier === "./debugLogger") return logger;
      if (specifier === "./dockManager") return {};
      if (specifier === "./i18nMain") return { i18nMain: { t: (key) => key } };
      if (specifier === "path" || specifier === "fs") return require(specifier);
      throw new Error(`Unexpected tray dependency: ${specifier}`);
    },
  });
  const manager = new loadedModule.exports();
  manager.loadTrayIcon = async () => icon;
  return {
    manager,
    icon,
    calls,
    registrations,
    preferenceWrites,
    warnings,
    errors,
    instances,
  };
}

function assertUsableTray(harness) {
  assert.equal(harness.instances.length, 1);
  assert.equal(harness.manager.tray, harness.instances[0]);
  assert.equal(harness.manager.tray.tooltip, "tray.tooltip");
  assert.ok(harness.manager.tray.menu.template.length > 0);
  assert.equal(harness.manager.tray.listeners.has("destroyed"), true);
  assert.deepEqual(harness.errors, []);
}

test("macOS registers a rightward fallback before creating its named tray", async () => {
  const harness = loadTrayManager("darwin");
  await harness.manager.createTray();

  assertUsableTray(harness);
  assert.deepEqual(harness.calls, ["register", "construct"]);
  assert.deepEqual(harness.registrations, [{ [POSITION_KEY]: 0 }]);
  assert.deepEqual(harness.manager.tray.args, [harness.icon, TRAY_GUID]);
  assert.deepEqual(harness.manager.tray.ignoreDoubleClickCalls, [true]);
  assert.equal(harness.manager.tray.listeners.has("click"), false);
  assert.deepEqual(harness.preferenceWrites, []);
});

test("independent launches keep the same macOS identity without writing saved positions", async () => {
  for (let launch = 0; launch < 2; launch += 1) {
    const harness = loadTrayManager("darwin");
    await harness.manager.createTray();

    assertUsableTray(harness);
    assert.equal(harness.manager.tray.args[1], TRAY_GUID);
    assert.deepEqual(harness.registrations, [{ [POSITION_KEY]: 0 }]);
    assert.deepEqual(harness.preferenceWrites, []);
  }
});

test("a macOS placement preference failure still creates a working named tray", async () => {
  const harness = loadTrayManager("darwin", {
    registrationError: new Error("registration unavailable"),
  });
  await harness.manager.createTray();

  assertUsableTray(harness);
  assert.deepEqual(harness.calls, ["register", "construct"]);
  assert.deepEqual(harness.manager.tray.args, [harness.icon, TRAY_GUID]);
  assert.deepEqual(harness.manager.tray.ignoreDoubleClickCalls, [true]);
  assert.equal(harness.warnings.length, 1);
  assert.equal(harness.warnings[0][1].error, "registration unavailable");
  assert.equal(harness.warnings[0][2], "tray");
  assert.deepEqual(harness.preferenceWrites, []);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} keeps its existing constructor and click behavior`, async () => {
    const harness = loadTrayManager(platform);
    await harness.manager.createTray();

    assertUsableTray(harness);
    assert.deepEqual(harness.calls, ["construct"]);
    assert.deepEqual(harness.manager.tray.args, [harness.icon]);
    assert.deepEqual(harness.registrations, []);
    assert.deepEqual(harness.preferenceWrites, []);
    assert.deepEqual(harness.manager.tray.ignoreDoubleClickCalls, []);
    assert.equal(harness.manager.tray.listeners.has("click"), true);
    let toggles = 0;
    harness.manager.toggleControlPanelFromTray = async () => {
      toggles += 1;
    };
    harness.manager.tray.listeners.get("click")();
    assert.equal(toggles, 1);
  });
}

test("an empty tray image does not register a preference or construct a tray", async () => {
  const harness = loadTrayManager("darwin");
  harness.manager.loadTrayIcon = async () => ({ isEmpty: () => true });
  await harness.manager.createTray();

  assert.equal(harness.manager.tray, null);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.preferenceWrites, []);
  assert.equal(harness.errors.length, 1);
});
```

The second test pins the app's persistence contract: stable identity plus fallback registration without a stored-value mutation. It does not simulate or prove macOS restoring a dragged position; Step 6 checks that behavior natively.

- [x] **Step 2: Run the focused test and record RED**

Run from the worktree with Node `24` selected:

```bash
node --test test/helpers/trayPlacement.test.js
```

Expected: the three new macOS behavior tests fail because the current implementation never registers the preference and supplies no GUID. The Windows, Linux, and empty-image characterization tests pass. Record the actual failure messages before changing `src/helpers/tray.js`; fix a test-harness error first if it fails for a different reason.

- [x] **Step 3: Make the minimal tray implementation change**

Extend the existing Electron import and add private constants after the existing imports:

```js
const { Tray, Menu, nativeImage, app, systemPreferences } = require("electron");
```

```js
// Keep this identity stable so macOS can restore the user's chosen position.
const MACOS_TRAY_GUID = "eb809902-04b5-5b08-b12a-f81d6f27e185";
const MACOS_TRAY_POSITION_KEY = `NSStatusItem Preferred Position ${MACOS_TRAY_GUID}`;
```

In `createTray()`, replace the existing `new Tray(trayIcon)` line and following macOS-only double-click block with:

```js
if (process.platform === "darwin") {
  try {
    // Best-effort AppKit preference; registration preserves saved user positions.
    systemPreferences.registerDefaults({ [MACOS_TRAY_POSITION_KEY]: 0 });
  } catch (error) {
    debugLogger.warn(
      "Could not register the default macOS tray position",
      { error: error?.message },
      "tray"
    );
  }
  this.tray = new Tray(trayIcon, MACOS_TRAY_GUID);
  this.tray.setIgnoreDoubleClickEvents(true);
} else {
  this.tray = new Tray(trayIcon);
}
```

Leave the empty-image return above this block and the existing menu/handler setup below it unchanged. No fallback re-creation, persistent preference write, position polling, or native helper is needed.

- [x] **Step 4: Run the focused regression suite and record GREEN**

```bash
node --test test/helpers/trayPlacement.test.js test/helpers/trayQuickActions.test.js test/helpers/trayActionPolicy.test.js test/helpers/dockPolicy.test.js
```

Expected: all new and existing tests pass. Inspect any failure against the original eight-test passing baseline. Existing module-type warnings are not new failures.

- [x] **Step 5: Format the named files and run the required quality checks**

Use the already installed dependencies; do not run installation or regenerate the lockfile.

```bash
npx --no-install prettier --write src/helpers/tray.js test/helpers/trayPlacement.test.js docs/superpowers/specs/2026-09-20-macos-menu-bar-placement-design.md docs/superpowers/plans/2026-09-20-macos-menu-bar-placement.md
npm run quality-check
npx --no-install prettier --check test/helpers/trayPlacement.test.js docs/superpowers/specs/2026-09-20-macos-menu-bar-placement-design.md docs/superpowers/plans/2026-09-20-macos-menu-bar-placement.md
node --check src/helpers/tray.js
git diff --check
git diff --stat
git status --short
```

The root lint configuration ignores `src/`, and the renderer configuration ignores helpers; `quality-check` still formats helpers and checks the rest of the project. The explicit Node syntax check and focused executed tests cover this CommonJS file. The added test and documentation need the explicit formatter check because the repository-wide formatter's glob runs inside `src/`.

Expected: quality checks pass, apart from already recorded baseline warnings; the change contains only this plan, the spec, the tray module, and its new test. Preserve any unrelated files if another process has modified the worktree. A formatting-only change needs no additional behavioral cycle; rerun the focused suite if formatting reveals a meaningful code change or another fix is made.

- [ ] **Step 6: Record the native acceptance result without overstating it**

The parent already ran this bounded Electron/AppKit probe successfully:

```bash
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron /tmp/ow-menu-bar-placement-20260920/placement-probe.cjs
```

Do not rerun it merely to reproduce an existing passing result. The recorded comparison is untreated `x=979` versus registered `x=1194`, both `width=32`, on a `1440 × 900` display. It verifies the preference convention on this machine; it does not replace application acceptance.

For the changed application, use the existing `openwhispr-dev-build` skill if the parent elects to launch a build; follow its installed-app shutdown and isolated-profile rules. Do not invent a new launcher or reset the user's installed preferences. With that build running:

1. Record the build/commit, application identity, macOS version, and initial visible neighboring icons.
2. Click the tray and verify the existing menu opens. Exercise opening the control panel.
3. Hold Command and drag OpenWhispr to a clearly different position. Record the new neighbors.
4. Quit through the existing tray menu, relaunch the same build with the same identity, and verify the chosen location survives.
5. Quit and relaunch again to detect a default applied only on the second start.
6. If a second display or menu-bar manager is present, record that context; do not claim coverage for an untested display or configuration.

If native application testing is unavailable, record the exact gap and hand it back to the parent. Do not convert a mocked test or standalone probe into a claim that user-drag persistence or an official installer was verified. Initial adoption may use the new default because the prior tray had an automatically generated identity; this is specified behavior, not a reason to mutate guessed legacy keys.

- [x] **Step 7: Hand the completed task to the requested independent review stages**

Report changed paths, RED/GREEN evidence, quality results, native evidence, and remaining limitations to the parent. The parent must then dispatch the separate deep-review agent against the complete branch diff and the separate fix agent for actionable findings. Review specifically for UUID stability/case, registration order, absence of persistent position writes, platform isolation, failure recovery, first-adoption wording, and honest native evidence. Do not commit or push from the planning agent; the parent owns the final commit/push decision after the requested review stages.

## Plan self-review

The single task covers every binding requirement: Step 1 tests the native API boundary and existing tray behavior; Step 3 implements the exact macOS branch; Steps 4–5 establish regression and repository quality results; Step 6 owns native persistence evidence; Step 7 preserves the requested independent review/fix sequence. There are no new public interfaces or dependent tasks. The GUID and preference key are identical throughout the spec, implementation example, and tests.
