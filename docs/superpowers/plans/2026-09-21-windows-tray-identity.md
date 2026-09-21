# Windows Tray Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give signed production Windows builds a permanent tray identity that Windows can use to retain the user's choices across relaunches and updates.

**Architecture:** Inject a marker only through the existing signed builder configuration, enforce executable signing for marked output in the existing packaging hook, and supply a permanent GUID only to the marked packaged production Windows tray. Unsigned builds and other platforms/channels retain the one-argument constructor. Installed and portable production builds share the identity.

**Tech Stack:** CommonJS JavaScript, Node 24 `node:test`, Electron 41.10.5, electron-builder/app-builder-lib 26.15.3.

**Spec:** `docs/superpowers/specs/2026-09-21-windows-tray-identity-design.md`.

## Global Constraints

- Windows identity/persistence only; visibility and exact placement remain controlled by Windows and the user.
- Permanent Windows production GUID: `9afd9bd5-53da-42ef-8334-6e2b494c66fe`.
- Packaged metadata marker: `windowsTrayIdentity: "signed-production-v1"`; unsigned override: `null`.
- Only Windows + packaged + resolved production channel + exact marker may receive the GUID.
- Marked Windows builds must enforce signing of the main executable; unsigned builds use `electron-builder.unsigned-win.json`.
- Keep `package.json`, `package-lock.json`, dependencies, `main.js`, and both workflow files unchanged.
- No new native helpers, dependencies, runtime subprocesses, registry edits, shell restarts, private APIs, or simulated dragging.
- Preserve existing icon loading, menu actions, tooltip, click handling, error handling, and macOS/Linux behavior.
- Do not touch macOS PR #2267, its worktree, or its GUID `eb809902-04b5-5b08-b12a-f81d6f27e185`.
- Toolchain: Node 24; locked Electron 41.10.5 and electron-builder/app-builder-lib 26.15.3; no version changes.
- Native acceptance scope: Windows 10 x64 and Windows 11 x64, with exact OS builds and app/artifact versions recorded.
- Preserve the selected sequence: planning, TDD/code-quality implementation, independent deep review, separate fixes.
- No merge or release is authorized; keep a resulting PR draft while native Windows acceptance remains unverified.

---

Work only in `/Users/joshuadavidpadoa/dev/openwhispr-windows-tray-identity-20260921` on `feat/windows-tray-identity`. The planning agent writes these two documents only. Execution mode has already been selected: the parent hands this integrated task to the implementation specialist, then a fresh deep reviewer, then a separate fixes specialist. Do not ask Josh to choose it again.

### Task 1: Add the Windows identity and its enforced build contract

**Files:**

- Modify: `src/helpers/tray.js` — import packaged metadata, define the permanent GUID, and select the constructor at current line 145.
- Modify: `electron-builder.json` — add `extraMetadata.windowsTrayIdentity` and `win.forceCodeSigning`.
- Modify: `electron-builder.unsigned-win.json` — null the marker and disable forced signing in this unsigned override.
- Modify: `scripts/afterPack.js` — add/export a narrow marked-Windows signing guard and invoke it first in the existing hook.
- Create: `test/helpers/windowsTrayIdentity.test.js` — runtime selection and existing tray behavior.
- Create: `test/scripts/windowsTraySigning.test.js` — real builder configuration merge and signing guard.
- Update after execution: this plan's checkboxes and the spec's evidence status with actual results only.

**Interfaces:**

- Consumes: `main.js` sets `process.env.OPENWHISPR_CHANNEL` to its resolved channel before requiring `src/helpers/tray.js`.
- Consumes: packaged `package.json.windowsTrayIdentity`, injected from effective `extraMetadata`.
- Produces: `verifyWindowsTraySigning(context): void`, named export from `scripts/afterPack.js`; it throws for marked Windows output whose main executable may bypass enforced signing.
- Uses builder 26.15.3's actual hook context: `context.electronPlatformName`, `context.appOutDir`, `context.packager.info.metadata`, `context.packager.forceCodeSigning`, `context.packager.platformSpecificBuildOptions`, `context.packager.appInfo.productFilename`, and `context.packager.shouldSignFile(fullExecutablePath, true)`.
- Preserves: `TrayManager` constructor, `createTray()` signature, existing exports, menus, and events.

- [x] **Step 1: Confirm the isolated branch and read the local patterns.**

Run these commands separately, from the worktree:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
cat /Users/joshuadavidpadoa/.agents/skills/code-quality/SKILL.md
cat src/helpers/tray.js
cat scripts/afterPack.js
cat test/helpers/trayQuickActions.test.js
cat test/scripts/afterPackWindowsOnnxRuntime.test.js
```

Use Node 24. The parent verified a working binary at `/Users/joshuadavidpadoa/.nvm/versions/node/v24.20.0/bin/node`; put that directory first on this shell's `PATH` if the default is older. Parent baseline: eight focused tray/Dock tests passed and `npm run quality-check` passed with six existing lint warnings. Confirm only the planning documents are new before starting; preserve any unrelated work.

- [x] **Step 2: Write the runtime regression tests.**

Create `test/helpers/windowsTrayIdentity.test.js` with this complete test body. Its stubs follow the repository's existing `Module._load` pattern and restore platform, environment, module cache, and loader after each scenario. Tests in this file must remain sequential because they temporarily change process globals.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const EXPECTED_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";
const trayModulePath = require.resolve("../../src/helpers/tray");

async function createTray({
  platform = "win32",
  isPackaged = true,
  channel = "production",
  metadata = { windowsTrayIdentity: "signed-production-v1" },
  icon = { isEmpty: () => false },
} = {}) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalChannel = process.env.OPENWHISPR_CHANNEL;
  const originalLoad = Module._load;
  const originalCache = require.cache[trayModulePath];
  const constructorCalls = [];
  const errors = [];

  class FakeTray {
    constructor(...args) {
      constructorCalls.push(args);
      this.events = new Map();
    }
    on(name, callback) {
      this.events.set(name, callback);
    }
    setToolTip(value) {
      this.tooltip = value;
    }
    setContextMenu(value) {
      this.menu = value;
    }
    setIgnoreDoubleClickEvents(value) {
      this.ignoreDoubleClick = value;
    }
  }

  try {
    Object.defineProperty(process, "platform", { value: platform });
    if (channel === null) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = channel;
    delete require.cache[trayModulePath];
    Module._load = function loadWithStubs(request, parent, isMain) {
      if (parent?.filename === trayModulePath) {
        if (request === "electron") {
          return {
            Tray: FakeTray,
            Menu: { buildFromTemplate: (items) => items },
            nativeImage: {},
            app: { isPackaged },
          };
        }
        if (request === "../../package.json") return metadata;
        if (request === "./debugLogger") {
          return {
            debug: () => {},
            info: () => {},
            error: (...args) => errors.push(args),
          };
        }
        if (request === "./dockManager") return {};
        if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    const TrayManager = require(trayModulePath);
    Module._load = originalLoad;
    const manager = new TrayManager();
    manager.loadTrayIcon = async () => icon;
    await manager.createTray();
    return { manager, constructorCalls, errors, icon };
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalChannel === undefined) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = originalChannel;
    if (originalCache) require.cache[trayModulePath] = originalCache;
    else delete require.cache[trayModulePath];
  }
}

test("marked packaged production Windows uses the permanent GUID", async () => {
  const first = await createTray();
  const second = await createTray();
  assert.deepEqual(first.constructorCalls, [[first.icon, EXPECTED_GUID]]);
  assert.deepEqual(second.constructorCalls, [[second.icon, EXPECTED_GUID]]);
  assert.deepEqual(first.errors, []);
});

test("every unsigned, development, other-channel, and non-Windows case keeps one argument", async () => {
  const scenarios = [
    { metadata: {} },
    { metadata: { windowsTrayIdentity: null } },
    { metadata: { windowsTrayIdentity: true } },
    { metadata: { windowsTrayIdentity: "signed-production-v2" } },
    { isPackaged: false },
    { channel: "development" },
    { channel: "staging" },
    { channel: "canary" },
    { channel: null },
    { platform: "darwin" },
    { platform: "linux" },
  ];
  for (const scenario of scenarios) {
    const result = await createTray(scenario);
    assert.deepEqual(result.constructorCalls, [[result.icon]], JSON.stringify(scenario));
    assert.deepEqual(result.errors, []);
  }
});

test("Windows keeps its tooltip, menu, click toggle, and destruction handler", async () => {
  const { manager } = await createTray();
  const tray = manager.tray;
  assert.equal(tray.tooltip, "tray.tooltip");
  assert.equal(tray.menu[0].label, "app.commandMenu.startListening");
  assert.equal(tray.menu.at(-1).label, "tray.quit");
  assert.deepEqual([...tray.events.keys()], ["click", "destroyed"]);
  let toggles = 0;
  manager.toggleControlPanelFromTray = async () => {
    toggles += 1;
  };
  tray.events.get("click")();
  assert.equal(toggles, 1);
  tray.events.get("destroyed")();
  assert.equal(manager.tray, null);
});

test("macOS and Linux retain their existing click and double-click behavior", async () => {
  const mac = (await createTray({ platform: "darwin" })).manager.tray;
  assert.equal(mac.ignoreDoubleClick, true);
  assert.equal(mac.events.has("click"), false);
  const linux = (await createTray({ platform: "linux" })).manager.tray;
  assert.equal(linux.ignoreDoubleClick, undefined);
  assert.equal(linux.events.has("click"), true);
});

test("missing and empty icons still skip tray construction", async () => {
  for (const icon of [null, { isEmpty: () => true }]) {
    const result = await createTray({ icon });
    assert.deepEqual(result.constructorCalls, []);
    assert.equal(result.manager.tray, null);
    assert.equal(result.errors.length, 1);
  }
});
```

- [x] **Step 3: Run the runtime tests and confirm the intended red result.**

```bash
node --test test/helpers/windowsTrayIdentity.test.js
```

Expected: the production test fails because current code supplies only the image. The remaining behavior tests should pass. A module-loading or environment error is not the intended failure; fix the harness before implementation.

- [x] **Step 4: Write the build-contract regression tests.**

Create `test/scripts/windowsTraySigning.test.js` with this body. It uses the installed builder's `getConfig`, `deepAssign`, and `shouldSignFile` implementation; do not replace them with a hand-written config merge or guessed exclusion matching.

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { deepAssign } = require("builder-util-runtime");
const { getConfig } = require("app-builder-lib/out/util/config/config");
const { WinPackager } = require("app-builder-lib/out/winPackager");
const { verifyWindowsTraySigning } = require("../../scripts/afterPack");

const projectDir = path.resolve(__dirname, "../..");
const sourceMetadata = require("../../package.json");
const MARKER = "signed-production-v1";

function makeContext(config, metadata = sourceMetadata, platform = "win32") {
  const appOutDir = path.join(projectDir, "dist", "win-unpacked");
  const packager = {
    info: { metadata: deepAssign({}, metadata, config.extraMetadata) },
    platformSpecificBuildOptions: config.win,
    forceCodeSigning: config.win.forceCodeSigning ?? config.forceCodeSigning ?? false,
    appInfo: { productFilename: "OpenWhispr" },
    shouldSignFile: WinPackager.prototype.shouldSignFile,
  };
  return { appOutDir, electronPlatformName: platform, packager };
}

test("the real signed configuration injects the marker and requires signing", async () => {
  const config = await getConfig(projectDir, "electron-builder.json");
  const context = makeContext(config);
  assert.equal(sourceMetadata.windowsTrayIdentity, undefined);
  assert.equal(context.packager.info.metadata.windowsTrayIdentity, MARKER);
  assert.equal(context.packager.forceCodeSigning, true);
  assert.equal(
    config.win.azureSignOptions.publisherName,
    "CN=Gizmo Labs Inc., O=Gizmo Labs Inc., L=Wilmington, S=Delaware, C=US"
  );
  assert.doesNotThrow(() => verifyWindowsTraySigning(context));
});

test("the real unsigned inheritance clears both the marker and forced signing", async () => {
  const config = await getConfig(projectDir, "electron-builder.unsigned-win.json");
  const context = makeContext(config, { ...sourceMetadata, windowsTrayIdentity: MARKER });
  assert.equal(config.win.azureSignOptions, null);
  assert.equal(context.packager.forceCodeSigning, false);
  assert.equal(context.packager.info.metadata.windowsTrayIdentity, null);
  assert.doesNotThrow(() => verifyWindowsTraySigning(context));
});

test("marked Windows output rejects every executable signing bypass", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  for (const win of [
    { forceCodeSigning: false },
    { signExecutable: false },
    { signAndEditExecutable: false },
    { signExts: ["!.exe"] },
  ]) {
    const config = deepAssign({}, base, { win });
    assert.throws(
      () => verifyWindowsTraySigning(makeContext(config)),
      /tray identity requires enforced executable signing/,
      JSON.stringify(win)
    );
  }
});

test("marked Windows output rejects a path-specific main executable exclusion", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  const executableSuffix = path.join(path.sep, "OpenWhispr.exe");
  const config = deepAssign({}, base, {
    win: { signExts: [`!${executableSuffix}`] },
  });
  assert.throws(
    () => verifyWindowsTraySigning(makeContext(config)),
    /tray identity requires enforced executable signing/
  );
});

test("a marker in effective source metadata cannot bypass the guard", () => {
  const context = makeContext(
    { win: { forceCodeSigning: false } },
    { windowsTrayIdentity: MARKER }
  );
  assert.throws(
    () => verifyWindowsTraySigning(context),
    /tray identity requires enforced executable signing/
  );
});

test("unmarked Windows output and non-Windows output retain their signing policy", () => {
  const unsigned = { win: { forceCodeSigning: false } };
  assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(unsigned, {})));
  for (const platform of ["darwin", "linux"]) {
    assert.doesNotThrow(() =>
      verifyWindowsTraySigning(makeContext(unsigned, { windowsTrayIdentity: MARKER }, platform))
    );
  }
});

test("normal positive executable signing patterns remain allowed", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  for (const signExts of [[".dll"], [".exe"], ["!.exe", ".exe"]]) {
    const config = deepAssign({}, base, { win: { signExts } });
    assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(config)));
  }
});

test("a path-specific main executable inclusion overrides a broad exclusion", async () => {
  const base = await getConfig(projectDir, "electron-builder.json");
  const executableSuffix = path.join(path.sep, "OpenWhispr.exe");
  const config = deepAssign({}, base, {
    win: { signExts: ["!.exe", executableSuffix] },
  });
  assert.doesNotThrow(() => verifyWindowsTraySigning(makeContext(config)));
});
```

- [x] **Step 5: Run the build tests and confirm the intended red result.**

```bash
node --test test/scripts/windowsTraySigning.test.js
```

Expected: missing marker/forced-signing assertions fail and the new guard is not yet a function. Configuration loading must succeed, including actual inheritance of the unsigned configuration.

- [x] **Step 6: Add the metadata and signing policy to both builder configurations.**

In `electron-builder.json`, add this root property near `appId`/`afterPack`:

```json
"extraMetadata": {
  "windowsTrayIdentity": "signed-production-v1"
}
```

Add this property in its existing `win` object:

```json
"forceCodeSigning": true
```

The complete unsigned override becomes:

```json
{
  "extends": "electron-builder.json",
  "extraMetadata": {
    "windowsTrayIdentity": null
  },
  "win": {
    "azureSignOptions": null,
    "forceCodeSigning": false
  }
}
```

The global metadata can also be present in non-Windows packages; the runtime platform gate ignores it and no non-Windows signing policy changes. Keep the source package and dependency manifests unchanged.

- [x] **Step 7: Enforce the marker contract in the existing packaging hook.**

Add this function above the `Main hook` section of `scripts/afterPack.js`:

```js
function verifyWindowsTraySigning(context) {
  const { packager } = context;
  if (
    context.electronPlatformName !== "win32" ||
    packager.info.metadata.windowsTrayIdentity !== "signed-production-v1"
  ) {
    return;
  }

  const options = packager.platformSpecificBuildOptions;
  if (
    packager.forceCodeSigning !== true ||
    options.signExecutable === false ||
    options.signAndEditExecutable === false ||
    !packager.shouldSignFile(
      path.join(context.appOutDir, `${packager.appInfo.productFilename}.exe`),
      true
    )
  ) {
    throw new Error(
      "afterPack: signed-production-v1 Windows tray identity requires enforced executable signing; use electron-builder.unsigned-win.json for unsigned builds"
    );
  }
}
```

Replace the existing main hook/export tail with:

```js
exports.default = async function (context) {
  verifyWindowsTraySigning(context);
  stripOnnxruntimeBinaries(context);
  wrapLinuxBinary(context);
  verifyMeetingAecHelper(context);
  verifyUnpackedBinaries(context);
  registerMacResourceBinariesForSigning(context);
};

exports.verifyWindowsOnnxRuntimePrivatized = verifyWindowsOnnxRuntimePrivatized;
exports.verifyWindowsTraySigning = verifyWindowsTraySigning;
```

One comment may explain that `signExts` exclusion bypasses builder 26.15.3's forced-signing check. Do not add an `afterSign` marker hook: it can run on unsigned output in this builder version.

- [x] **Step 8: Select the Windows tray constructor using the resolved channel and packaged metadata.**

Add this import and constant alongside the existing imports in `src/helpers/tray.js`:

```js
const { windowsTrayIdentity } = require("../../package.json");

// Permanent identity for signed production Windows builds; keep across releases.
const WINDOWS_PRODUCTION_TRAY_GUID = "9afd9bd5-53da-42ef-8334-6e2b494c66fe";
```

Replace only the current `this.tray = new Tray(trayIcon);` line in `createTray()` with:

```js
const useWindowsIdentity =
  process.platform === "win32" &&
  app.isPackaged === true &&
  process.env.OPENWHISPR_CHANNEL === "production" &&
  windowsTrayIdentity === "signed-production-v1";

this.tray = useWindowsIdentity
  ? new Tray(trayIcon, WINDOWS_PRODUCTION_TRAY_GUID)
  : new Tray(trayIcon);
```

Do not change the macOS double-click branch or add a JavaScript retry fallback; native icon-add failure is not a reliable constructor exception.

- [x] **Step 9: Run the focused suite and confirm green behavior.**

```bash
node --test test/helpers/windowsTrayIdentity.test.js test/scripts/windowsTraySigning.test.js test/helpers/trayQuickActions.test.js test/helpers/trayActionPolicy.test.js test/helpers/dockPolicy.test.js test/scripts/afterPackWindowsOnnxRuntime.test.js
```

Expected: every focused test passes. Inspect the diff to confirm the existing default hook actually calls the guard before other work, not merely exports an unused function.

- [x] **Step 10: Format the named files, then run repository checks.**

```bash
npx --no-install prettier --write src/helpers/tray.js scripts/afterPack.js electron-builder.json electron-builder.unsigned-win.json test/helpers/windowsTrayIdentity.test.js test/scripts/windowsTraySigning.test.js docs/superpowers/specs/2026-09-21-windows-tray-identity-design.md docs/superpowers/plans/2026-09-21-windows-tray-identity.md
npm run quality-check
npm test
git diff --check
git diff -- package.json package-lock.json main.js .github/workflows/build-and-notarize.yml .github/workflows/release.yml
```

Run each command separately. The final command must have no output. Report inherited warnings/failures accurately; fix regressions introduced by these named changes. If the full suite reports a macOS timing failure or native database binding issue, record the exact test/error and compare the parent's baseline before attributing it to this change. Do not refresh dependency versions or rebuild unrelated native dependencies to hide a baseline issue.

- [x] **Step 11: Self-review, record evidence, and commit only this integrated change.**

Apply the code-quality checklist. Confirm source `package.json` has no marker; unsigned inheritance yields `null`; no runtime code treats packaging or channel alone as signing; the GUID differs from macOS; the resolved channel is used; icon/menu/event behavior is unchanged; and the guard evaluates effective metadata and executable signing eligibility.

Update the spec's evidence paragraph and this plan's completed checkboxes with exact test counts and outstanding native work. Do not label signed artifacts or Windows persistence verified without those observations. Stage only:

```bash
git add src/helpers/tray.js scripts/afterPack.js electron-builder.json electron-builder.unsigned-win.json test/helpers/windowsTrayIdentity.test.js test/scripts/windowsTraySigning.test.js docs/superpowers/specs/2026-09-21-windows-tray-identity-design.md docs/superpowers/plans/2026-09-21-windows-tray-identity.md
git diff --cached --stat
git diff --cached --check
git commit -m "feat: preserve signed Windows tray identity"
```

The parent owns publication and review-stage sequencing. Do not push, merge, change PR readiness, or claim native acceptance from this implementation task.

Execution evidence, 2026-09-21:

- Runtime RED: `node --test test/helpers/windowsTrayIdentity.test.js` ran 5 tests; 4 passed and the marked packaged production Windows case failed only because the constructor received the image without `9afd9bd5-53da-42ef-8334-6e2b494c66fe`.
- Build-contract RED: after replacing the circular deep import with the installed package's public `WinPackager` export, `node --test test/scripts/windowsTraySigning.test.js` loaded both real configurations and ran 6 tests; all 6 failed on the missing marker, unsigned override, or signing guard.
- Focused GREEN: the six-file tray, Dock, and packaging command passed 22/22 tests. `npm run quality-check` passed with the 6 pre-existing warnings.
- Full suite: the original `npm test` run ran 4,715 tests; 4,701 passed, 1 failed, 12 skipped, and 1 remains todo. The sole failure was the unrelated load-sensitive cleanup in `modelManagerBridgeDownloadStatus.test.js` (`ENOTEMPTY` removing a temporary `.cache` directory); its file passed 11/11 when rerun alone. The parent independently reran `node --import tsx --test --test-concurrency=4 'test/**/*.test.js'` at `09dc1a9c`: 4,715 total, 4,702 passed, 0 failed, 12 skipped, 1 todo, exit 0 (`/tmp/ow-windows-tray-full-tests-parent.log`).
- Independent review: requested repair because the signing guard checked a basename while builder filters and signs the full executable path. The parent reproduced the mismatch with builder's real `shouldSignFile` and `signIf`, then ruled that the binding marked-output contract requires the full path. The review also requested clearer wording for missing/unknown values at the tray selection point.
- Repair RED: `node --test test/scripts/windowsTraySigning.test.js` ran 8 tests; 6 passed. The new path-specific exclusion case failed because the guard accepted it, and the path-specific positive override case failed because the guard rejected it.
- Repair GREEN: after using `path.join(context.appOutDir, productFilename + ".exe")`, the six-file tray, Dock, and packaging command passed 24/24 tests. Named-file Prettier made no further changes. `npm run quality-check` passed with the same 6 existing warnings.
- No Windows 10/11 session, signed artifact, signature subject verification, install/portable update pair, reboot, or tray visibility/order persistence observation was available. Native acceptance remains unverified and the PR must remain draft.

### Native acceptance and subsequent specialist stages

- [x] **Independent deep review:** the fresh reviewer checked the whole branch at `09dc1a9c` and requested repair of the basename/full-path signing-policy mismatch plus clarification of channel-resolution wording.
- [x] **Separate fixes:** the repair specialist reproduced both directions of the full-path mismatch, changed the guard to builder's actual executable path, clarified resolved-channel wording, and reran the affected checks.
- [ ] **Repair rereview:** a fresh reviewer must inspect the repair commit and focused evidence before the parent makes any readiness decision.
- [ ] **Native acceptance:** execute the spec's Windows 10/11 matrix when real Windows and authorized signed candidates are available; otherwise leave it unverified and keep the PR draft. Neither unsigned PR CI nor macOS unit tests prove signed Windows persistence.

On Windows, identify the actual running executable with the following PowerShell commands. Replace the process id with the one selected from the first command; this is attended evidence gathering, not a packaging or runtime dependency:

```powershell
Get-Process OpenWhispr | Select-Object Id, Path
$trayProcessId = Read-Host 'OpenWhispr main process id'
$trayExePath = (Get-Process -Id $trayProcessId).Path
$traySignature = Get-AuthenticodeSignature -LiteralPath $trayExePath
$traySignature | Select-Object Status, Path, @{Name='Subject';Expression={$_.SignerCertificate.Subject}}
Get-FileHash -LiteralPath $trayExePath -Algorithm SHA256
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
```

Require signature `Status: Valid` and record the subject's `O=Gizmo Labs Inc.` before treating a build as the signed-path case. Test the extracted executable for portable builds. Record first adoption, manual visible and hidden choices, two normal relaunches, reboot, a signed update pair, changed install path, two portable versions, unsigned copies at two paths, channel coexistence, and menu/click behavior. Do not edit the registry, restart Explorer, or force icon placement to manufacture a passing result.
