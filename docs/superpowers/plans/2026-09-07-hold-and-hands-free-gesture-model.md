# Hold and Hands-free — Gesture Model, Settings Rows, Migration Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hold the only activation model for every hotkey in PR #1978: default `push` on both processes, a one-time migration of stored `tap` to `push`, two read-only gesture rows under each hotkey in Settings, and a one-time migration card in the pill window on the first hotkey press after the update.

**Architecture:** Plan 1 of 2 (the motion work is `2026-09-07-hold-and-hands-free-motion.md`, a PR stacked on this branch). Everything here lands on `feature/hotkey-activation-modes` (PR #1978). The renderer's Zustand settings store and the main process's `.env`-backed `EnvironmentManager` each flip their default to `push` and run a marker-guarded one-time migration; the main process keeps its existing "demote an unsupported Hold to Tap" convergence and gains the mirror "promote back to Hold when the hotkey can Hold" so the stored mode is only ever a capability verdict, never a user choice. The Settings Tap/Hold selector leaves `SettingsPage.tsx` (it stays in the tree for onboarding) and is replaced by read-only gesture rows built from the hands-free tip card's keycap tokens. The migration card reuses the tip card's shell through a small extraction.

**Tech Stack:** Electron main (CommonJS, `main.js`, `src/helpers/*.js`), React 19 renderer (TypeScript/JSX, Vite, Tailwind, Zustand, react-i18next), tests with `node --test` + tsx (`npm test`), the renderer test harness at `test/lib/rendererTestHarness.js` (Vite SSR module loading with stubbed browser globals).

**Spec:** `docs/superpowers/specs/2026-09-07-hold-and-hands-free-design.md` (on this branch, commit `6462633d`). Section 2 is what this plan implements; section 4 "Verification" (unit + testbook) is covered here for the gesture model. Design page with the approved card copy and Settings mock-ups: https://claude.ai/code/artifact/312f3f40-4264-4bc4-92c5-5e62bae20df4 (v2.2).

## Global Constraints

- **Branch and worktree.** Work in a worktree of `~/dev/openwhispr-desktop` checked out at `feature/hotkey-activation-modes` (head `6462633d` at planning time). Never switch the shared clone at `~/dev/openwhispr-desktop` itself (it is on another branch). If the planning worktree at `/private/tmp/claude-501/-Users-joshuadavidpadoa-dev-titan/88a56550-77a5-49ab-866c-be9a16172316/scratchpad/ow-1978` is gone, create one: `git -C ~/dev/openwhispr-desktop worktree add <path> feature/hotkey-activation-modes`, then `npm ci` inside it (the `openwhispr-dev-build` skill clones `node_modules` faster if a rig is wanted).
- **Default is `push`** on both sides: renderer store keys `activationMode`, `voiceAgentActivationMode`, `translationActivationMode`; main env keys `ACTIVATION_MODE`, `VOICE_AGENT_ACTIVATION_MODE`, `TRANSLATION_ACTIVATION_MODE`.
- **`tap` is a verdict, not a choice.** After this plan, a slot is `tap` only because its hotkey or backend cannot Hold (`hotkeyManager.supportsPushToTalk` says no). Settings must say why (`pushToTalkUnavailableReason`).
- **Migration markers:** renderer `localStorage` key `activationModeHoldMigration` = `"done"`; main env key `ACTIVATION_MODE_HOLD_MIGRATED` = `"true"`. A second run is a no-op.
- **Card copy, final and approved (do not edit):** chip `New in this update`; title `Hold to speak, release to finish`; body line 1 `We changed how your hotkey works: hold {{hotkey}} while you talk.` (hotkey rendered as keycap tokens for the user's real dictation hotkey); body line 2 `Double press it for hands‑free, press again to stop.` (note the non-breaking hyphen U+2011 in `hands‑free`). No button. Dismissed by the X or by the next hotkey press. Shown once, in the pill window, on the first hotkey press after a migration actually changed a slot, never at launch. Fresh installs never see it.
- **Gesture row copy:** `Hold to speak` / `Release to finish` with tokens `Hold` + keycaps; `Hands-free` / `Press again to stop` with tokens `Double press` + keycaps. When the slot cannot Hold, one row: `Press to start, press again to stop` followed by the existing reason line. Locale keys live under `settingsPage.general.hotkey.gestures.*` in `src/locales/en/translation.json`; the ten other locales (`de es fr it ja pt ru zh-CN zh-TW` plus any other directory under `src/locales/`) get the English strings until translated. `npm run i18n:check` must pass.
- **Keep:** `ActivationModeSelector` (used by `OnboardingFlow.tsx` — onboarding is a non-goal), the `setActivationMode` / `setVoiceAgentActivationMode` / `setTranslationActivationMode` store setters, the `activation-mode-changed` / `slot-activation-mode-changed` IPC, and every existing demotion path. Meeting mode's Settings layout is untouched.
- **Do not touch:** `src/helpers/pressGesture.js`, `src/utils/windowSizeLadder.js` and its test, `OnboardingFlow.tsx`, anything Linux-parity related beyond what exists.
- **Every task ends green:** `npm test` (expected: one pre-existing environmental failure on this machine, `settingsStore imports without a bare localStorage global`, because Node 25 defines `localStorage` globally — it fails on `main` here too and passes in CI; every other test must pass), `npm run typecheck`, `npm run lint`, `npm run i18n:check`.
- **Commit style:** conventional, matching the stack (`feat(hotkeys): …`, `feat(settings): …`, `fix(…)`, `test(…)`), one commit per task, pushed to `origin/feature/hotkey-activation-modes`. Never merge #1978 — Josh gives the go per PR.
- **Explain code concepts briefly for a non-technical reader** in commit bodies and the PR update (project rule).

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/stores/settingsStore.ts` | Renderer defaults → `push`; module-scope `migrateActivationModesToHold()`; new state `holdMigrationCardPending`, `holdMigrationCardShown` + setter |
| `src/helpers/environment.js` | Main defaults → `push`; `migrateActivationModesToHold()`; new persisted marker key |
| `main.js` | Calls the main-side migration before the activation-mode cache is seeded |
| `src/helpers/hotkeyManager.js` | `updateHotkey` promotes a demoted dictation slot back to Hold when the new hotkey can Hold (mirror of the existing demotion) |
| `src/helpers/windowManager.js` | `updateHotkey` follows any converged mode, not only `tap` |
| `src/helpers/ipcHandlers.js` | Slot reconciliation after a voice-agent/translation hotkey change goes both ways (demote and promote) |
| `src/locales/*/translation.json` | New `settingsPage.general.hotkey.gestures.*` and `app.holdMigrationCard.*` keys |
| `src/components/ui/HotkeyKeycaps.tsx` (new) | Renders one hotkey as `<kbd>` tokens — shared by the tip card, the migration card and the gesture rows |
| `src/components/dictation/TipCardShell.tsx` (new) | The card chrome (badge, X, title, body, optional countdown arc) extracted from `HandsFreeTipCard` |
| `src/components/dictation/HandsFreeTipCard.tsx` | Becomes a thin composition of `TipCardShell` + `HotkeyKeycaps`; behaviour unchanged |
| `src/components/dictation/HoldMigrationCard.tsx` (new) | The migration card |
| `src/hooks/useHoldMigrationCard.js` (new) | Shows the card on the first hotkey press after a migration; dismisses on X or the next press |
| `src/components/ui/HotkeyGestureRows.tsx` (new) | The two read-only gesture rows (or the single tap-only row + reason) |
| `src/components/SettingsPage.tsx` | `ActivationModeRow` removed; gesture rows mounted under the three hotkey inputs |
| `src/App.jsx` | Mounts the migration card beside the tip card; sizes the window and holds auto-hide while it shows |
| `src/helpers/windowConfig.js` | `WINDOW_SIZES.HANDS_FREE_TIP` grows to fit the taller card |
| `src/types/electron.ts` | No new IPC; unchanged unless the typecheck asks |
| Tests | `test/helpers/settingsStoreHoldMigration.test.js`, `test/helpers/environmentVoiceAgentHotkey.test.js`, `test/helpers/hotkeyActivationMode.test.js`, `test/helpers/windowManagerActivationModeConvergence.test.js`, `test/components/hotkeyKeycaps.test.js`, `test/components/hotkeyGestureRows.test.js`, `test/components/holdMigrationCard.test.js`, `test/hooks/useHoldMigrationCard.test.js`, updated `test/helpers/settingsStoreSlotActivationModes.test.js` |

Interface contracts between tasks are in each task's **Interfaces** block.

---

### Task 1: Renderer defaults and the one-time Hold migration in the settings store

**Files:**
- Modify: `src/stores/settingsStore.ts` — migration site next to `migrateMicrophoneSelectionMode()` (lines 213–229), defaults (lines 1347–1354), `BOOLEAN_SETTINGS` list (around line 285–305), the store interface (around lines 948–952), the setters block (around line 2084)
- Modify: `test/helpers/settingsStoreSlotActivationModes.test.js` (default assertion)
- Test (new): `test/helpers/settingsStoreHoldMigration.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: store fields `holdMigrationCardPending: boolean` (read-only, derived from the migration) and `holdMigrationCardShown: boolean` with setter `setHoldMigrationCardShown(shown: boolean): void`; `localStorage` keys `activationModeHoldMigration` (`"done"`), `holdMigrationCardPending` (`"true"|"false"`), `holdMigrationCardShown` (`"true"|"false"`). Task 7's hook reads these.

Plain-English idea: the app remembers each hotkey's mode in the browser-style storage of the renderer. On the first start after this update we rewrite `tap` to `push` once, leave a marker so we never do it again, and remember whether anything actually changed so the pill can decide later whether to show the "we changed something" card.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/settingsStoreHoldMigration.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The migration runs at module scope, so every case imports the store fresh
// (its own cachePrefix) and reads the storage the import left behind.
async function importStore(t, { initialStorage, cachePrefix }) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: { electronAPI: {} },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { storage, state: useSettingsStore.getState(), useSettingsStore };
}

test("an existing install with untouched modes moves every slot to Hold and arms the card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-existing-",
    initialStorage: { onboardingCompleted: "true" },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
  assert.equal(storage.getItem("activationMode"), "push");
  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "true");
  assert.equal(state.holdMigrationCardPending, true);
  assert.equal(state.holdMigrationCardShown, false);
});

test("a stored Tap becomes Hold and a stored Hold stays untouched", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-stored-tap-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "tap",
      voiceAgentActivationMode: "push",
    },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(storage.getItem("holdMigrationCardPending"), "true");
});

test("an install already on Hold everywhere arms no card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-already-hold-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "push",
      voiceAgentActivationMode: "push",
      translationActivationMode: "push",
    },
  });

  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
  assert.equal(state.holdMigrationCardPending, false);
});

test("a fresh install defaults to Hold without a migration and never arms the card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-fresh-",
    initialStorage: {},
  });

  assert.equal(state.activationMode, "push");
  assert.equal(storage.getItem("activationMode"), null);
  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
});

test("after the marker a stored Tap is a capability verdict and stays Tap", async (t) => {
  const { state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-marker-",
    initialStorage: {
      onboardingCompleted: "true",
      activationModeHoldMigration: "done",
      activationMode: "tap",
    },
  });

  assert.equal(state.activationMode, "tap");
});

test("the card-shown flag persists through its setter", async (t) => {
  const { storage, state, useSettingsStore } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-shown-",
    initialStorage: { onboardingCompleted: "true" },
  });

  state.setHoldMigrationCardShown(true);

  assert.equal(useSettingsStore.getState().holdMigrationCardShown, true);
  assert.equal(storage.getItem("holdMigrationCardShown"), "true");
});
```

In `test/helpers/settingsStoreSlotActivationModes.test.js`, the first test asserts the defaults are `tap`. Change both assertions and the test name:

```js
test("per-slot activation modes default to Hold and persist through their setters", async (t) => {
  ...
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
```

The rest of that test (setter round-trips, `"bogus"` normalising to `tap`, the notified list) stays as is — the setters still normalise unknown values to `tap`, which is what the main process would do with an unknown value too (Task 2 changes main's normalisation to `push`; the renderer setter is never called with garbage in practice, and keeping it strict means a corrupt value can never silently claim Hold on a hotkey that cannot Hold).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/helpers/settingsStoreHoldMigration.test.js test/helpers/settingsStoreSlotActivationModes.test.js`
Expected: the new file fails on `activationMode` being `"tap"` / `holdMigrationCardPending` being `undefined`; the updated default test fails with `'tap' !== 'push'`.

- [ ] **Step 3: Implement the migration and the defaults**

In `src/stores/settingsStore.ts`, directly after `migrateMicrophoneSelectionMode();` (line 229), add:

```ts
// Hold is the only activation model now (2026-09-07 design). One-time: a
// stored Tap becomes Hold, and so does an *absent* mode on an install that
// already finished onboarding — those users were on the old Tap default and
// their hotkey behaviour is about to change, which is what the migration
// card explains. A fresh install (onboarding not completed) simply gets the
// new default and never sees the card. After the marker, a stored Tap is a
// capability verdict written by the main process (the hotkey or backend
// cannot Hold) and must be left alone.
const ACTIVATION_MODE_STORAGE_KEYS = [
  "activationMode",
  "voiceAgentActivationMode",
  "translationActivationMode",
] as const;

function migrateActivationModesToHold() {
  if (!isBrowser) return;
  if (localStorage.getItem("activationModeHoldMigration") === "done") return;
  const existingInstall = localStorage.getItem("onboardingCompleted") === "true";
  let changed = false;
  for (const key of ACTIVATION_MODE_STORAGE_KEYS) {
    const stored = localStorage.getItem(key);
    if (stored === "push") continue;
    if (stored === "tap" || existingInstall) {
      localStorage.setItem(key, "push");
      changed = true;
    }
  }
  localStorage.setItem("activationModeHoldMigration", "done");
  localStorage.setItem("holdMigrationCardPending", String(changed));
}

migrateActivationModesToHold();
```

Change the three defaults (lines 1347–1354) from `"tap"` fallbacks to `"push"`:

```ts
  activationMode: (readString("activationMode", "push") === "tap" ? "tap" : "push") as
    "tap" | "push",
  voiceAgentActivationMode: (readString("voiceAgentActivationMode", "push") === "tap"
    ? "tap"
    : "push") as "tap" | "push",
  translationActivationMode: (readString("translationActivationMode", "push") === "tap"
    ? "tap"
    : "push") as "tap" | "push",
  // Set by migrateActivationModesToHold() above; read-only from here on.
  holdMigrationCardPending: readBoolean("holdMigrationCardPending", false),
  holdMigrationCardShown: readBoolean("holdMigrationCardShown", false),
```

Add to the store interface next to `translationActivationMode` (around line 952):

```ts
  holdMigrationCardPending: boolean;
  holdMigrationCardShown: boolean;
  setHoldMigrationCardShown: (shown: boolean) => void;
```

Add the setter after `setTranslationActivationMode` (around line 2107):

```ts
  setHoldMigrationCardShown: (shown: boolean) => {
    if (isBrowser) localStorage.setItem("holdMigrationCardShown", String(shown));
    set({ holdMigrationCardShown: shown });
  },
```

Add `"holdMigrationCardShown"` and `"holdMigrationCardPending"` to the `BOOLEAN_SETTINGS` array (next to `"floatingIconAutoHide"`), so the cross-window `storage` listener parses them as booleans.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/helpers/settingsStoreHoldMigration.test.js test/helpers/settingsStoreSlotActivationModes.test.js`
Expected: all pass.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/stores/settingsStore.ts test/helpers/settingsStoreHoldMigration.test.js test/helpers/settingsStoreSlotActivationModes.test.js
git commit -m "feat(hotkeys): Hold is the renderer default; migrate stored Tap once and arm the migration card

Every activation mode now defaults to push. A one-time, marker-guarded
migration rewrites a stored tap (or an absent mode on an install that
finished onboarding) to push and records whether anything changed, which
is what decides later whether the pill shows the one-time card."
```

---

### Task 2: Main-process defaults and the one-time migration in `EnvironmentManager`

**Files:**
- Modify: `src/helpers/environment.js` — `PERSISTED_KEYS` (lines 32–72), `getActivationMode()`, `getSlotActivationModes()`, `saveSlotActivationMode()`, `saveActivationMode()` (the block after `saveMeetingKey()`), plus a new `migrateActivationModesToHold()`
- Modify: `main.js` line 1005 (seed of the activation-mode cache) and the slot-restore loop at lines 1170–1182
- Modify/Test: `test/helpers/environmentVoiceAgentHotkey.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EnvironmentManager#migrateActivationModesToHold(): boolean` (true when it changed a stored value); `getActivationMode()` / `getSlotActivationModes()` default to `"push"`; env key `ACTIVATION_MODE_HOLD_MIGRATED`.

- [ ] **Step 1: Write the failing tests**

In `test/helpers/environmentVoiceAgentHotkey.test.js`, the test `per-slot activation modes persist, normalize, and reject unknown slots` asserts the defaults are `tap` and that `"bogus"` normalises to `tap`. Change it:

```js
  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "push",
    translation: "push",
  });

  environmentManager.saveSlotActivationMode("voiceAgent", "tap");
  environmentManager.saveSlotActivationMode("translation", "bogus");
  assert.equal(environmentManager.saveSlotActivationMode("meeting", "push"), false);

  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "tap",
    translation: "push",
  });
```

Append a new test to the same file (it reuses `loadEnvironmentManager`, `installDotenvStub`, `restoreEnvironment` defined at the top of that file):

```js
test("migrateActivationModesToHold flips every stored Tap to Hold exactly once", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hold-migration-"));
  const keys = [
    "ACTIVATION_MODE",
    "VOICE_AGENT_ACTIVATION_MODE",
    "TRANSLATION_ACTIVATION_MODE",
    "ACTIVATION_MODE_HOLD_MIGRATED",
  ];
  const environmentSnapshot = new Map(
    keys.map((name) => [name, { present: Object.hasOwn(process.env, name), value: process.env[name] }])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  for (const name of keys) delete process.env[name];
  process.env.ACTIVATION_MODE = "tap";
  process.env.VOICE_AGENT_ACTIVATION_MODE = "push";
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  let persisted = 0;
  environmentManager.saveAllKeysToEnvFile = async () => {
    persisted += 1;
    return {};
  };

  assert.equal(environmentManager.getActivationMode(), "tap");
  assert.equal(environmentManager.migrateActivationModesToHold(), true);
  assert.equal(environmentManager.getActivationMode(), "push");
  assert.deepEqual(environmentManager.getSlotActivationModes(), {
    voiceAgent: "push",
    translation: "push",
  });
  assert.equal(process.env.ACTIVATION_MODE_HOLD_MIGRATED, "true");
  assert.equal(persisted, 1);

  // A later demotion verdict survives the next launch: the marker holds.
  environmentManager.saveActivationMode("tap");
  assert.equal(environmentManager.migrateActivationModesToHold(), false);
  assert.equal(environmentManager.getActivationMode(), "tap");
});

test("an unset activation mode reads as Hold", async (t) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-hold-default-"));
  const environmentSnapshot = new Map(
    ["ACTIVATION_MODE"].map((name) => [
      name,
      { present: Object.hasOwn(process.env, name), value: process.env[name] },
    ])
  );
  const originalResourcesPath = process.resourcesPath;
  process.resourcesPath = userDataDirectory;
  delete process.env.ACTIVATION_MODE;
  t.after(() => {
    restoreEnvironment(environmentSnapshot);
    process.resourcesPath = originalResourcesPath;
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  installDotenvStub(t);
  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  environmentManager.saveAllKeysToEnvFile = async () => ({});

  assert.equal(environmentManager.getActivationMode(), "push");
  environmentManager.saveActivationMode("nonsense");
  assert.equal(environmentManager.getActivationMode(), "push");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/helpers/environmentVoiceAgentHotkey.test.js`
Expected: the changed assertions fail (`'tap' !== 'push'`), the new tests fail with `migrateActivationModesToHold is not a function`.

- [ ] **Step 3: Implement**

In `src/helpers/environment.js`:

Add `"ACTIVATION_MODE_HOLD_MIGRATED",` to `PERSISTED_KEYS` right after `...Object.values(SLOT_ACTIVATION_MODE_ENV_KEYS),`.

Replace the four activation-mode methods:

```js
  // Hold is the only activation model. An unset mode is Hold; a stored
  // "tap" is a capability verdict (this hotkey/backend cannot deliver a
  // release), written by the convergence paths, never by the user.
  getActivationMode() {
    return this._getKey("ACTIVATION_MODE") === "tap" ? "tap" : "push";
  }

  getSlotActivationModes() {
    const modes = {};
    for (const [slotName, envKey] of Object.entries(SLOT_ACTIVATION_MODE_ENV_KEYS)) {
      modes[slotName] = this._getKey(envKey) === "tap" ? "tap" : "push";
    }
    return modes;
  }

  saveSlotActivationMode(slotName, mode) {
    const envKey = SLOT_ACTIVATION_MODE_ENV_KEYS[slotName];
    if (!envKey) return false;
    const validMode = mode === "tap" ? "tap" : "push";
    const result = this._saveKey(envKey, validMode);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  saveActivationMode(mode) {
    const validMode = mode === "tap" ? "tap" : "push";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile().catch(() => {});
    return result;
  }

  // One-time (marker-guarded) move of every stored Tap to Hold. Runs before
  // the hotkey manager seeds its cache, so the existing convergence — a
  // silent demotion of any Hold the registered hotkey cannot deliver — then
  // decides the final verdict per slot. Returns true when a value changed.
  migrateActivationModesToHold() {
    if (this._getKey("ACTIVATION_MODE_HOLD_MIGRATED") === "true") return false;
    process.env.ACTIVATION_MODE_HOLD_MIGRATED = "true";
    let changed = false;
    for (const envKey of ["ACTIVATION_MODE", ...Object.values(SLOT_ACTIVATION_MODE_ENV_KEYS)]) {
      if (this._getKey(envKey) !== "tap") continue;
      process.env[envKey] = "push";
      changed = true;
    }
    this.saveAllKeysToEnvFile().catch(() => {});
    return changed;
  }
```

In `main.js`, replace line 1005:

```js
  // Hold-only model: rewrite a stored Tap once, then seed the cache. A Hold
  // the current hotkey cannot deliver is demoted below (slots) and after the
  // macOS hotkey restore (dictation), exactly as before.
  environmentManager.migrateActivationModesToHold();
  const dictationHoldApplied = await windowManager.setActivationModeCache(
    environmentManager.getActivationMode()
  );
  if (!dictationHoldApplied && environmentManager.getActivationMode() === "push") {
    environmentManager.saveActivationMode("tap");
  }
```

The slot-restore loop at lines 1170–1182 and the darwin demotion at lines 1184–1192 stay exactly as they are — they are the convergence the spec calls "let `demoteHold` decide".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/helpers/environmentVoiceAgentHotkey.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/environment.js main.js test/helpers/environmentVoiceAgentHotkey.test.js
git commit -m "feat(hotkeys): Hold is the main-process default; migrate a stored Tap once at launch

The .env-backed activation modes default to push. At startup a one-time
migration rewrites any stored tap to push before the hotkey manager seeds
its cache; the existing convergence then demotes any Hold the registered
hotkey cannot deliver, so tap is only ever a capability verdict."
```

---

### Task 3: Prefer Hold on every registration — promote a demoted slot back when its hotkey can Hold

**Files:**
- Modify: `src/helpers/hotkeyManager.js` lines 1436–1448 (`updateHotkey`, the `demoteHold` block)
- Modify: `src/helpers/windowManager.js` lines 1391–1400 (`updateHotkey`)
- Modify: `src/helpers/ipcHandlers.js` lines 10410–10424 (`revalidateSlotActivationMode`)
- Test: `test/helpers/hotkeyActivationMode.test.js` (new case after the existing `updateHotkey converges …` test at line 139)
- Test (new): `test/helpers/windowManagerActivationModeConvergence.test.js`

**Interfaces:**
- Consumes: `hotkeyManager.supportsPushToTalk(hotkey, slot)`, `windowManager.setSlotActivationModeCache(slot, mode, { notifyFailure })` (existing).
- Produces: `hotkeyManager.updateHotkey()` result carries `activationMode: "tap" | "push"` whenever the mode converged in either direction; `windowManager.updateHotkey()` follows either direction; `reconcileSlotActivationMode(slotName, settingKey)` in `ipcHandlers.js` (renamed from `revalidateSlotActivationMode`).

Why: with no Tap choice in the UI, a slot demoted to Tap for an unsupported hotkey would otherwise be stuck on Tap forever after the user picks a hotkey that can Hold. "Prefer push, let demoteHold decide" has to be re-evaluated at every registration.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/hotkeyActivationMode.test.js`:

```js
test("updateHotkey promotes a demoted dictation slot back to Hold when the new hotkey can Hold", async () => {
  const manager = new HotkeyManager();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  manager.saveHotkeyToRenderer = async () => true;
  manager.notifyActiveHotkey = () => undefined;
  manager.supportsPushToTalk = (hotkey) => hotkey !== "F13";
  try {
    // A slot demoted to Tap for F13 (cannot Hold) comes back to Hold on a
    // hotkey that can — Tap is a verdict about the hotkey, not a choice.
    manager.activationMode = "tap";
    const promoted = await manager.updateHotkey("Command+Period", () => undefined);
    assert.equal(promoted.success, true);
    assert.equal(promoted.activationMode, "push");
    assert.equal(manager.activationMode, "push");

    // A registration that fails keeps Tap: nothing changed hands.
    manager.activationMode = "tap";
    manager.setupShortcuts = () => ({ success: false, error: "nope" });
    const failed = await manager.updateHotkey("Command+Comma", () => undefined);
    assert.equal(failed.success, false);
    assert.equal(manager.activationMode, "tap");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});
```

Create `test/helpers/windowManagerActivationModeConvergence.test.js`. Copy the whole `Module._load` stub block from the top of `test/helpers/windowManagerHandsFree.test.js` (from `const originalLoad = Module._load;` through the line that restores it, including every `if (request === "./…")` branch — it is the only known-good set of stubs that lets `WindowManager` be required in a test), then add:

```js
const WindowManager = require("../../src/helpers/windowManager");

function managerWithHotkeyResult(result) {
  const manager = new WindowManager();
  manager.mainWindow = null;
  manager.hotkeyManager = {
    updateHotkey: async () => result,
    isInListeningMode: () => false,
    getNativeListenerKeys: () => [],
    isUsingNativeShortcut: () => false,
  };
  manager.createHotkeyCallback = () => () => undefined;
  manager.resetNativePushState = () => undefined;
  manager.reconcileNativeKeyListeners = () => undefined;
  return manager;
}

test("updateHotkey follows a converged mode in both directions", async () => {
  const demoted = managerWithHotkeyResult({ success: true, activationMode: "tap" });
  demoted._cachedActivationMode = "push";
  await demoted.updateHotkey("F13");
  assert.equal(demoted.getActivationMode(), "tap");

  const promoted = managerWithHotkeyResult({ success: true, activationMode: "push" });
  promoted._cachedActivationMode = "tap";
  await promoted.updateHotkey("Command+Period");
  assert.equal(promoted.getActivationMode(), "push");

  const untouched = managerWithHotkeyResult({ success: true });
  untouched._cachedActivationMode = "tap";
  await untouched.updateHotkey("Command+Period");
  assert.equal(untouched.getActivationMode(), "tap");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/helpers/hotkeyActivationMode.test.js test/helpers/windowManagerActivationModeConvergence.test.js`
Expected: the promotion case fails (`activationMode` stays `"tap"`, result has no `activationMode`); the windowManager "promoted" case fails (`'tap' !== 'push'`).

- [ ] **Step 3: Implement**

In `src/helpers/hotkeyManager.js`, replace the `demoteHold` block (lines 1436–1448) with:

```js
    // Hold is the only model, so the stored mode is a verdict about the
    // hotkey, re-judged at every registration: a Hold this hotkey cannot
    // deliver (a macOS plain key with no release source, a modifier-only
    // combo on a DE-native backend) converges to Tap, and a Tap left behind
    // by an earlier demotion comes back to Hold once the hotkey can deliver
    // a release. The caller is told either way; a failed registration
    // restores the previous mode because nothing changed hands.
    const previousMode = this.activationMode === "push" ? "push" : "tap";
    const preferredMode = this.supportsPushToTalk(primary) ? "push" : "tap";
    const converged = preferredMode !== previousMode;
    if (converged) this.activationMode = preferredMode;
    const result = await this._applyHotkeyUpdate(hotkeys, primary, callback);
    if (converged) {
      if (result.success) result.activationMode = preferredMode;
      else this.activationMode = previousMode;
    }
    return result;
```

In `src/helpers/windowManager.js` `updateHotkey` (lines 1391–1400), replace the `tap`-only check:

```js
    // The manager converged the mode for this hotkey (Hold it cannot
    // deliver → Tap, or a demoted Tap → Hold): the cache and the native
    // listeners follow; the IPC layer persists it and tells the renderer.
    if (result?.activationMode && result.activationMode !== this._cachedActivationMode) {
      this._cachedActivationMode = result.activationMode;
      this.resetNativePushState();
      this.reconcileNativeKeyListeners();
    }
    return result;
```

The `update-hotkey` IPC handler at `ipcHandlers.js` lines 3783–3800 already persists and broadcasts whatever `result.activationMode` says; only its comment needs the second direction mentioned.

In `src/helpers/ipcHandlers.js`, replace `revalidateSlotActivationMode` (lines 10410–10424) with a two-way reconcile, and rename the four call sites (lines 10438, 10449, 10475, 10486) to `reconcileSlotActivationMode`:

```js
    // Agent mode handlers
    // Hold is the only model, so a voiceAgent/translation slot's mode is a
    // verdict about its hotkey, re-judged after every hotkey change: Hold
    // when the (new) hotkey can deliver a release, Tap when it cannot or the
    // slot is unbound. Cache, env and every renderer follow, silently.
    const reconcileSlotActivationMode = async (slotName, settingKey) => {
      const windowManager = this.windowManager;
      const hotkey = windowManager.hotkeyManager.getSlotHotkey?.(slotName);
      const preferred =
        hotkey && windowManager.hotkeyManager.supportsPushToTalk(hotkey, slotName)
          ? "push"
          : "tap";
      if (windowManager.getSlotActivationMode(slotName) === preferred) return;
      await windowManager.setSlotActivationModeCache(slotName, preferred, {
        notifyFailure: false,
      });
      const effective = windowManager.getSlotActivationMode(slotName);
      this.environmentManager.saveSlotActivationMode?.(slotName, effective);
      for (const browserWindow of BrowserWindow.getAllWindows()) {
        if (!browserWindow.isDestroyed()) {
          browserWindow.webContents.send("setting-updated", { key: settingKey, value: effective });
        }
      }
      windowManager.reconcileNativeKeyListeners();
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/helpers/hotkeyActivationMode.test.js test/helpers/windowManagerActivationModeConvergence.test.js test/helpers/hotkeyModeInfoIpc.test.js`
Expected: all pass (the existing `updateHotkey converges …` test at line 139 must still pass: its `kept` case expects `activationMode` undefined when nothing converged — the new code only sets it when `converged`).

- [ ] **Step 5: Commit**

```bash
git add src/helpers/hotkeyManager.js src/helpers/windowManager.js src/helpers/ipcHandlers.js test/helpers/hotkeyActivationMode.test.js test/helpers/windowManagerActivationModeConvergence.test.js
git commit -m "feat(hotkeys): re-judge Hold at every registration, promoting a demoted slot back

With no Tap choice left, a slot demoted to Tap for a hotkey that cannot
Hold must return to Hold when the user picks one that can. updateHotkey
and the per-slot reconcile now converge in both directions and report
the verdict the same way the demotion already did."
```

---

### Task 4: Locale strings for the gesture rows and the migration card

**Files:**
- Modify: `src/locales/en/translation.json` (`settingsPage.general.hotkey` object, `app` object)
- Modify: every other `src/locales/<lang>/translation.json` (English values copied in)
- Verify: `npm run i18n:check`

**Interfaces:**
- Produces the keys below, used verbatim by Tasks 6 and 7:

| Key | English |
|---|---|
| `settingsPage.general.hotkey.gestures.holdTitle` | `Hold to speak` |
| `settingsPage.general.hotkey.gestures.holdDetail` | `Release to finish` |
| `settingsPage.general.hotkey.gestures.handsFreeTitle` | `Hands-free` |
| `settingsPage.general.hotkey.gestures.handsFreeDetail` | `Press again to stop` |
| `settingsPage.general.hotkey.gestures.doublePress` | `Double press` |
| `settingsPage.general.hotkey.gestures.tapOnlyTitle` | `Press to start, press again to stop` |
| `app.holdMigrationCard.badge` | `New in this update` |
| `app.holdMigrationCard.title` | `Hold to speak, release to finish` |
| `app.holdMigrationCard.description` | `We changed how your hotkey works: hold {{hotkey}} while you talk.` |
| `app.holdMigrationCard.gesture` | `Double press it for hands‑free, press again to stop.` |

The `Hold` verb token reuses the existing `common.hold` key.

- [ ] **Step 1: Add the English keys**

Edit `src/locales/en/translation.json`: inside `settingsPage.general.hotkey` add a `gestures` object with the six keys; inside `app` add a `holdMigrationCard` object with the four keys (values exactly as in the table; keep `hands‑free` with U+2011). Keep the file's existing key order otherwise; run `npx prettier --write src/locales/en/translation.json`.

- [ ] **Step 2: Run the i18n check to see it fail on the other locales**

Run: `npm run i18n:check`
Expected: `[i18n] Missing key de/translation: settingsPage.general.hotkey.gestures.holdTitle` and the same for every other locale and key; exit 1.

- [ ] **Step 3: Copy the English strings into every other locale**

Run this one-off from the worktree root (it inserts the two objects into each non-English locale without disturbing the rest):

```bash
node - <<'EOF'
const fs = require("fs");
const path = require("path");
const dir = path.join("src", "locales");
const en = JSON.parse(fs.readFileSync(path.join(dir, "en", "translation.json"), "utf8"));
for (const lang of fs.readdirSync(dir)) {
  if (lang === "en") continue;
  const file = path.join(dir, lang, "translation.json");
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.settingsPage.general.hotkey.gestures = { ...en.settingsPage.general.hotkey.gestures };
  data.app.holdMigrationCard = { ...en.app.holdMigrationCard };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
EOF
npx prettier --write "src/locales/*/translation.json"
```

- [ ] **Step 4: Verify**

Run: `npm run i18n:check`
Expected: `[i18n] Locale keys and placeholders are consistent.`

- [ ] **Step 5: Commit**

```bash
git add src/locales
git commit -m "feat(i18n): gesture-row and migration-card strings, English in every locale until translated"
```

---

### Task 5: Shared keycap tokens and the card shell (refactor, no behaviour change)

**Files:**
- Create: `src/components/ui/HotkeyKeycaps.tsx`
- Create: `src/components/dictation/TipCardShell.tsx`
- Modify: `src/components/dictation/HandsFreeTipCard.tsx`
- Test (new): `test/components/hotkeyKeycaps.test.js`
- Test (unchanged, must still pass): `test/components/handsFreeTipCard.test.js`

**Interfaces:**
- Produces:
  - `HotkeyKeycaps({ hotkey: string; className?: string })` — renders `formatHotkeyLabel(hotkey).split("+")` as `<kbd>` tokens separated by ` + `, wrapped in a `<span>`; each `kbd` has the exact classes the tip card uses today: `rounded-md border border-border/40 bg-foreground/5 px-1.5 py-0.5 font-mono text-[12px] text-foreground/65 shadow-sm`.
  - `TipCardShell({ badge: ReactNode; badgeIcon: ReactNode; title: ReactNode; children: ReactNode; align: "left"|"center"|"right"; inPlaceOfPill: boolean; exiting?: boolean; countdown?: { durationMs: number; paused: boolean } | null; onDismiss: () => void; onMouseEnter?: () => void; onMouseLeave?: () => void; className?: string })` — the `<section role="status">` with class `hands-free-tip-card …` (the motion CSS in `dictation-panel.css` is keyed on that class, so both cards keep it), the badge chip (`hands-free-tip-badge`), the X button (`aria-label={t("common.dismiss")}`), the title `<p>`, and `children` as the body; renders `CardCountdownArc` only when `countdown` is given. Exports `TIP_CARD_WIDTH = 320` (the tip card re-exports it as `HANDS_FREE_TIP_CARD_WIDTH` so `windowConfig.js`'s comment stays true).

- [ ] **Step 1: Write the failing test**

Create `test/components/hotkeyKeycaps.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function render(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-hotkey-keycaps-test-" });
  const mod = await vite.ssrLoadModule("/components/ui/HotkeyKeycaps.tsx");
  return renderToStaticMarkup(createElement(mod.HotkeyKeycaps, props));
}

test("one keycap per hotkey part, joined by plus signs", async (t) => {
  const markup = await render(t, { hotkey: "Control+Shift+Space" });
  assert.equal((markup.match(/<kbd/g) || []).length, 3);
  assert.equal((markup.match(/ \+ /g) || []).length, 2);
});

test("a single key renders one keycap and no joiner", async (t) => {
  const markup = await render(t, { hotkey: "F8" });
  assert.equal((markup.match(/<kbd/g) || []).length, 1);
  assert.doesNotMatch(markup, / \+ /);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/components/hotkeyKeycaps.test.js`
Expected: FAIL — module `/components/ui/HotkeyKeycaps.tsx` not found.

- [ ] **Step 3: Implement the two components and re-base the tip card on them**

Create `src/components/ui/HotkeyKeycaps.tsx`:

```tsx
import { cn } from "../lib/utils";
import { formatHotkeyLabel } from "../../utils/hotkeys";

interface HotkeyKeycapsProps {
  hotkey: string;
  className?: string;
}

/** One hotkey as keycap tokens — the same tokens the hands-free tip card uses. */
export function HotkeyKeycaps({ hotkey, className }: HotkeyKeycapsProps) {
  const parts = formatHotkeyLabel(hotkey).split("+");
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && " + "}
          <kbd className="rounded-md border border-border/40 bg-foreground/5 px-1.5 py-0.5 font-mono text-[12px] text-foreground/65 shadow-sm">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}
```

Create `src/components/dictation/TipCardShell.tsx`:

```tsx
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { CardCountdownArc } from "./CardCountdownArc";

export const TIP_CARD_WIDTH = 320;
const CARD_RADIUS = 24;

const ALIGN_CLASS = {
  right: "right-0",
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
};

interface TipCardShellProps {
  badge: ReactNode;
  badgeIcon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  align: "left" | "center" | "right";
  /** With the pill auto-hidden the card stands where the pill would be. */
  inPlaceOfPill: boolean;
  exiting?: boolean;
  countdown?: { durationMs: number; paused: boolean } | null;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}

/** The chrome shared by the hands-free tip and the Hold migration card. */
export function TipCardShell({
  badge,
  badgeIcon,
  title,
  children,
  align,
  inPlaceOfPill,
  exiting = false,
  countdown = null,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  className,
}: TipCardShellProps) {
  const { t } = useTranslation();
  return (
    <section
      role="status"
      aria-live="polite"
      data-exiting={exiting || undefined}
      className={cn(
        "hands-free-tip-card absolute z-10 w-80 overflow-hidden rounded-3xl border border-border/50 bg-surface-0 p-5",
        "shadow-[var(--shadow-modal)]",
        inPlaceOfPill ? "bottom-0" : "bottom-full mb-2",
        ALIGN_CLASS[align],
        className
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {countdown && (
        <CardCountdownArc
          width={TIP_CARD_WIDTH}
          radius={CARD_RADIUS}
          durationMs={countdown.durationMs}
          paused={countdown.paused}
        />
      )}
      <span className="hands-free-tip-badge inline-flex h-6 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-medium">
        {badgeIcon}
        {badge}
      </span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={onDismiss}
        className="absolute right-4.5 top-4.5 flex size-7 items-center justify-center rounded-full border border-border/55 bg-surface-2 text-muted-foreground shadow-sm transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
      <p className="mt-3.5 text-base font-medium leading-snug text-foreground">{title}</p>
      {children}
    </section>
  );
}
```

Rewrite `src/components/dictation/HandsFreeTipCard.tsx` as a composition (same props, same rendered markup):

```tsx
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyKeycaps } from "../ui/HotkeyKeycaps";
import { TipCardShell, TIP_CARD_WIDTH } from "./TipCardShell";

export const HANDS_FREE_TIP_CARD_WIDTH = TIP_CARD_WIDTH;
// The translated sentence carries the hotkey as `{{hotkey}}`; rendering it as
// keycaps means splitting the resolved copy around that slot.
const HOTKEY_SLOT = "\u0000";

interface HandsFreeTipCardProps {
  hotkey: string;
  align: "left" | "center" | "right";
  /** With the pill auto-hidden the tip stands where the pill would be. */
  inPlaceOfPill: boolean;
  exiting?: boolean;
  progressDuration: number;
  progressPaused: boolean;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/** Post-hold nudge toward the double-press hands-free gesture. */
export function HandsFreeTipCard({
  hotkey,
  align,
  inPlaceOfPill,
  exiting = false,
  progressDuration,
  progressPaused,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: HandsFreeTipCardProps) {
  const { t } = useTranslation();
  const [before, after = ""] = t("app.handsFreeTip.description", { hotkey: HOTKEY_SLOT }).split(
    HOTKEY_SLOT
  );

  return (
    <TipCardShell
      badge={t("app.handsFreeTip.badge")}
      badgeIcon={<Zap className="size-3.5" aria-hidden="true" />}
      title={t("app.handsFreeTip.title")}
      align={align}
      inPlaceOfPill={inPlaceOfPill}
      exiting={exiting}
      countdown={{ durationMs: progressDuration, paused: progressPaused }}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {before}
        <HotkeyKeycaps hotkey={hotkey} />
        {after}
      </p>
    </TipCardShell>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/components/hotkeyKeycaps.test.js test/components/handsFreeTipCard.test.js`
Expected: all pass, including the unchanged tip-card test (`<kbd` count 2 for `Control+\``, `toast-border-progress 6000ms`, `aria-label="common.dismiss"`, the `bottom-full`/`right-0`/`left-1/2`/`bottom-0` placement cases).

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/HotkeyKeycaps.tsx src/components/dictation/TipCardShell.tsx src/components/dictation/HandsFreeTipCard.tsx test/components/hotkeyKeycaps.test.js
git commit -m "refactor(dictation): lift the tip card's shell and keycap tokens into shared components

No behaviour change. The migration card and the Settings gesture rows
reuse the same chrome and tokens, so they now live in one place."
```

---

### Task 6: Settings — two read-only gesture rows replace the Tap/Hold selector

**Files:**
- Create: `src/components/ui/HotkeyGestureRows.tsx`
- Modify: `src/components/SettingsPage.tsx` — line 85 (import), lines 243–283 (`ActivationModeRow`), lines 1124–1131 (destructure), lines 3904–3915, 3938–3948, 3969–3979 (the three usages)
- Test (new): `test/components/hotkeyGestureRows.test.js`

**Interfaces:**
- Consumes: `useHotkeyModeInfo(scope, hotkey, slot)` from `src/hooks/useHotkeyModeInfo.ts` (returns `supportsPushToTalk`, `pushToTalkUnavailableReason`), `HotkeyKeycaps` (Task 5), locale keys (Task 4), `parseHotkeyList` from `src/utils/hotkeys`.
- Produces: `HotkeyGestureRows({ slot: "dictation"|"voiceAgent"|"translation"; hotkey: string; mode: "tap"|"push" })`.

Design (from the page, "Settings · one hotkey, two gestures"): each row is a left label (bold title, muted detail below) and a right-hand token group — a verb chip (`Hold` / `Double press`, the `hands-free-tip-badge` chip style for the hands-free row, a neutral chip for Hold) followed by the slot's keycaps. Only the first hotkey of a list is shown.

- [ ] **Step 1: Write the failing test**

Create `test/components/hotkeyGestureRows.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Static render: effects never run, so useHotkeyModeInfo reports its defaults
// (Hold supported, no reason). The rows are driven by the slot's effective
// mode, which the store already carries; the hook only supplies the reason.
async function render(t, props) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hotkey-gesture-rows-test-",
  });
  const mod = await vite.ssrLoadModule("/components/ui/HotkeyGestureRows.tsx");
  return renderToStaticMarkup(
    createElement(mod.HotkeyGestureRows, { slot: "dictation", hotkey: "Control+`", ...props })
  );
}

test("a Hold slot shows the hold row and the hands-free row with the slot's keycaps", async (t) => {
  const markup = await render(t, { mode: "push" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdDetail/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeDetail/);
  assert.match(markup, /common\.hold/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.doublePress/);
  // Two rows × two keycaps (Control, `).
  assert.equal((markup.match(/<kbd/g) || []).length, 4);
  assert.doesNotMatch(markup, /tapOnlyTitle/);
});

test("a Tap slot shows one press-to-toggle row and says why Hold is unavailable", async (t) => {
  const markup = await render(t, { mode: "tap" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.tapOnlyTitle/);
  assert.doesNotMatch(markup, /gestures\.holdTitle/);
  assert.doesNotMatch(markup, /gestures\.handsFreeTitle/);
  // No reason came back from main in a static render: the generic line.
  assert.match(markup, /windows\.pttUnavailable/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("only the first hotkey of a list is rendered as keycaps", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "F8,Control+Shift+Space" });
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("no rows without a hotkey", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "" });
  assert.equal(markup, "");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/components/hotkeyGestureRows.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rows and mount them in Settings**

Create `src/components/ui/HotkeyGestureRows.tsx`:

```tsx
import type { ReactNode } from "react";
import { Hand, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { parseHotkeyList } from "../../utils/hotkeys";
import { HotkeyKeycaps } from "./HotkeyKeycaps";

type HotkeySlot = "dictation" | "voiceAgent" | "translation";

interface HotkeyGestureRowsProps {
  slot: HotkeySlot;
  hotkey: string;
  /** The slot's effective mode from the store: Hold, or Tap when it cannot Hold. */
  mode: "tap" | "push";
}

function GestureRow({
  title,
  detail,
  tokens,
}: {
  title: string;
  detail?: string;
  tokens: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{title}</p>
        {detail && <p className="text-[11px] leading-snug text-muted-foreground/70">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{tokens}</div>
    </div>
  );
}

function VerbChip({ icon, label, accent = false }: { icon: ReactNode; label: string; accent?: boolean }) {
  return (
    <span
      className={
        accent
          ? "hands-free-tip-badge inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[12px] font-medium"
          : "inline-flex h-[22px] items-center gap-1 rounded-full bg-foreground/[0.07] px-2 text-[12px] font-medium text-muted-foreground"
      }
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * Read-only description of how a hotkey slot is driven. Hold is the only
 * activation model; a slot shows the press-to-toggle row only when its hotkey
 * or backend cannot deliver a release, and then says why.
 */
export function HotkeyGestureRows({ slot, hotkey, mode }: HotkeyGestureRowsProps) {
  const { t } = useTranslation();
  const { pushToTalkUnavailableReason } = useHotkeyModeInfo("settings", hotkey, slot);
  const [primary] = parseHotkeyList(hotkey);
  if (!primary) return null;

  const keycaps = <HotkeyKeycaps hotkey={primary} />;
  const plus = <span className="text-[12px] text-muted-foreground/70">+</span>;

  if (mode === "tap") {
    return (
      <div className="flex flex-col">
        <GestureRow title={t("settingsPage.general.hotkey.gestures.tapOnlyTitle")} tokens={keycaps} />
        {/* A Hold that is missing with no explanation reads as broken; say why in place. */}
        <p className="text-[11px] leading-snug text-muted-foreground/70">
          {pushToTalkUnavailableReason || t("windows.pttUnavailable")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/30">
      <GestureRow
        title={t("settingsPage.general.hotkey.gestures.holdTitle")}
        detail={t("settingsPage.general.hotkey.gestures.holdDetail")}
        tokens={
          <>
            <VerbChip icon={<Hand className="size-3" aria-hidden="true" />} label={t("common.hold")} />
            {plus}
            {keycaps}
          </>
        }
      />
      <GestureRow
        title={t("settingsPage.general.hotkey.gestures.handsFreeTitle")}
        detail={t("settingsPage.general.hotkey.gestures.handsFreeDetail")}
        tokens={
          <>
            <VerbChip
              icon={<Zap className="size-3" aria-hidden="true" />}
              label={t("settingsPage.general.hotkey.gestures.doublePress")}
              accent
            />
            {plus}
            {keycaps}
          </>
        }
      />
    </div>
  );
}
```

In `src/components/SettingsPage.tsx`:

1. Line 85: replace `import { ActivationModeSelector } from "./ui/ActivationModeSelector";` with `import { HotkeyGestureRows } from "./ui/HotkeyGestureRows";`.
2. Delete `ActivationModeRow` (the comment at line 243 through the closing brace at line 283).
3. Lines 1126–1131: drop `setActivationMode`, `setVoiceAgentActivationMode`, `setTranslationActivationMode` from the destructure (they are now unused here; the store keeps them). Keep `activationMode`, `voiceAgentActivationMode`, `translationActivationMode`.
4. Replace the dictation usage (lines 3904–3915):

```tsx
                {(!isUsingNativeShortcut || getCachedPlatform() === "linux") && (
                  <SettingsPanelRow>
                    <HotkeyGestureRows slot="dictation" hotkey={dictationKey} mode={activationMode} />
                    {getCachedPlatform() === "linux" && activationMode === "push" && (
                      <LinuxPttSetupInfo isAvailable={linuxPttAvailable} />
                    )}
                  </SettingsPanelRow>
                )}
```

5. Replace the voice-agent usage (lines 3938–3948):

```tsx
                  {voiceAgentKey && (!isUsingNativeShortcut || getCachedPlatform() === "linux") && (
                    <SettingsPanelRow>
                      <HotkeyGestureRows
                        slot="voiceAgent"
                        hotkey={voiceAgentKey}
                        mode={voiceAgentActivationMode}
                      />
                    </SettingsPanelRow>
                  )}
```

6. Replace the translation usage (lines 3969–3979) the same way with `slot="translation"`, `hotkey={translationKey}`, `mode={translationActivationMode}`.

The meeting section (lines 3982 onward) is untouched.

- [ ] **Step 4: Run the tests and the checks**

Run: `npm test -- test/components/hotkeyGestureRows.test.js test/helpers/activationModeSelector.test.js`
Expected: pass (the selector test still passes: the component stays for onboarding).

Run: `npm run typecheck && npm run lint`
Expected: clean (lint catches any now-unused import or variable in `SettingsPage.tsx`).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/HotkeyGestureRows.tsx src/components/SettingsPage.tsx test/components/hotkeyGestureRows.test.js
git commit -m "feat(settings): read-only gesture rows replace the Tap/Hold selector under each hotkey

Hold is no longer a choice, so each hotkey section describes the two
gestures it supports (hold to speak, double press for hands-free) in the
tip card's keycap tokens, or the single press-to-toggle row plus the
reason when the slot cannot Hold. The selector stays for onboarding."
```

---

### Task 7: The migration card — component, hook, pill-window wiring, window size

**Files:**
- Create: `src/components/dictation/HoldMigrationCard.tsx`
- Create: `src/hooks/useHoldMigrationCard.js`
- Modify: `src/App.jsx` — import block (lines 26–27), the `useHandsFreeTip` call (lines 299–310), the size-owner call (line 318), the auto-hide effect (lines 381–412), the card render block (lines 730–755)
- Modify: `src/helpers/windowConfig.js` line 140–142 (`HANDS_FREE_TIP` size)
- Test (new): `test/components/holdMigrationCard.test.js`, `test/hooks/useHoldMigrationCard.test.js`

**Interfaces:**
- Consumes: store fields from Task 1; `TipCardShell`, `HotkeyKeycaps` (Task 5); locale keys (Task 4); `window.electronAPI.onStartDictation` / `onToggleDictation` (existing preload listeners at `preload.js` lines 84–90 — a hold or latch arrives as `start-dictation`, a Tap-mode press as `toggle-dictation`; a pill click never goes through IPC, so it does not count as a hotkey press); `resolveHandsFreeTipHotkey` from `src/helpers/handsFreeTip.js` (first entry of the dictation hotkey list, default fallback).
- Produces: `useHoldMigrationCard(): { visible: boolean; exiting: boolean; dismiss: () => void }`; `HoldMigrationCard({ hotkey, align, inPlaceOfPill, exiting, onDismiss, onMouseEnter, onMouseLeave })`.

Behaviour: the hook counts hotkey presses. On the first press, if the migration armed the card (`holdMigrationCardPending`), it has not been shown (`holdMigrationCardShown` false) and dictation is on Hold right now (`activationMode === "push"` — the card would lie about holding if the slot was demoted), it shows the card and marks it shown (persisted, so a relaunch never shows it again). The next press dismisses it with the tip card's 200 ms exit; the X does the same. While a panel is mounted the card is not rendered (the pill area belongs to the panel) but stays pending-dismissal.

- [ ] **Step 1: Write the failing tests**

Create `test/components/holdMigrationCard.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderCard(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hold-migration-card-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/HoldMigrationCard.tsx");
  return renderToStaticMarkup(
    createElement(mod.HoldMigrationCard, {
      hotkey: "Control+`",
      align: "right",
      inPlaceOfPill: false,
      onDismiss: () => {},
      ...props,
    })
  );
}

test("the card carries the approved copy, the dictation keycaps, an X and nothing else", async (t) => {
  const markup = await renderCard(t);

  assert.match(markup, /app\.holdMigrationCard\.badge/);
  assert.match(markup, /app\.holdMigrationCard\.title/);
  assert.match(markup, /app\.holdMigrationCard\.description/);
  assert.match(markup, /app\.holdMigrationCard\.gesture/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
  assert.match(markup, /aria-label="common\.dismiss"/);
  // No button beyond the X, no countdown arc: the next press is the practice.
  assert.equal((markup.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(markup, /toast-border-progress/);
});

test("the card shares the tip card's placement rules", async (t) => {
  assert.match(await renderCard(t, { align: "right" }), /bottom-full[^"]*right-0|right-0[^"]*bottom-full/);
  assert.match(await renderCard(t, { align: "left" }), /left-0/);
  assert.match(await renderCard(t, { inPlaceOfPill: true }), /bottom-0/);
});
```

Create `test/hooks/useHoldMigrationCard.test.js` (same harness shape as `test/hooks/useHandsFreeTip.test.js`):

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Drives the hook the way the pill window does: main reports hotkey presses
// over start-dictation (hold, latch) and toggle-dictation (a Tap-mode slot).
// The store is seeded through storage; the marker keeps the module-scope
// migration from rewriting the seed.
async function mountHook(t, { initialStorage, cachePrefix }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { activationModeHoldMigration: "done", ...initialStorage },
    window: {
      electronAPI: {
        onStartDictation: (callback) => {
          listeners.start = callback;
          return () => {};
        },
        onToggleDictation: (callback) => {
          listeners.toggle = callback;
          return () => {};
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const { useHoldMigrationCard } = await vite.ssrLoadModule("/hooks/useHoldMigrationCard.js");

  let result;
  function Harness() {
    result = useHoldMigrationCard();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  const press = async (channel = "start") => {
    await React.act(async () => {
      listeners[channel]?.({ inputKind: "dictation" });
    });
  };
  return { storage, press, read: () => result };
}

test("the first hotkey press after a migration shows the card once; the next press dismisses it", async (t) => {
  const { storage, press, read } = await mountHook(t, {
    cachePrefix: "openwhispr-hold-migration-hook-first-press-",
    initialStorage: { holdMigrationCardPending: "true", activationMode: "push" },
  });

  assert.equal(read().visible, false);
  await press("start");
  assert.equal(read().visible, true);
  assert.equal(storage.getItem("holdMigrationCardShown"), "true");

  await press("start");
  assert.equal(read().visible, false);
});

test("the X dismisses the card", async (t) => {
  const { press, read } = await mountHook(t, {
    cachePrefix: "openwhispr-hold-migration-hook-dismiss-",
    initialStorage: { holdMigrationCardPending: "true", activationMode: "push" },
  });
  await press("toggle");
  assert.equal(read().visible, true);
  await React.act(async () => read().dismiss());
  assert.equal(read().visible, false);
});

test("a card already shown, a fresh install, or a demoted dictation slot never shows it", async (t) => {
  for (const [suffix, initialStorage] of [
    ["shown", { holdMigrationCardPending: "true", holdMigrationCardShown: "true", activationMode: "push" }],
    ["fresh", { holdMigrationCardPending: "false", activationMode: "push" }],
    ["demoted", { holdMigrationCardPending: "true", activationMode: "tap" }],
  ]) {
    const { press, read } = await mountHook(t, {
      cachePrefix: `openwhispr-hold-migration-hook-${suffix}-`,
      initialStorage,
    });
    await press("start");
    assert.equal(read().visible, false, suffix);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/components/holdMigrationCard.test.js test/hooks/useHoldMigrationCard.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the component and the hook**

Create `src/components/dictation/HoldMigrationCard.tsx`:

```tsx
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyKeycaps } from "../ui/HotkeyKeycaps";
import { TipCardShell } from "./TipCardShell";

const HOTKEY_SLOT = "\u0000";

interface HoldMigrationCardProps {
  /** The user's real dictation hotkey (first of the list). */
  hotkey: string;
  align: "left" | "center" | "right";
  inPlaceOfPill: boolean;
  exiting?: boolean;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/**
 * One-time card on the first hotkey press after the update moved the user
 * from Tap to Hold. It introduces the change; it never asks for a decision.
 * No button: the X dismisses it, and the next press is the practice.
 */
export function HoldMigrationCard({
  hotkey,
  align,
  inPlaceOfPill,
  exiting = false,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: HoldMigrationCardProps) {
  const { t } = useTranslation();
  const [before, after = ""] = t("app.holdMigrationCard.description", {
    hotkey: HOTKEY_SLOT,
  }).split(HOTKEY_SLOT);

  return (
    <TipCardShell
      badge={t("app.holdMigrationCard.badge")}
      badgeIcon={<Sparkles className="size-3.5" aria-hidden="true" />}
      title={t("app.holdMigrationCard.title")}
      align={align}
      inPlaceOfPill={inPlaceOfPill}
      exiting={exiting}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {before}
        <HotkeyKeycaps hotkey={hotkey} />
        {after}
      </p>
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {t("app.holdMigrationCard.gesture")}
      </p>
    </TipCardShell>
  );
}
```

Create `src/hooks/useHoldMigrationCard.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";

const EXIT_MS = 200;

/**
 * Shows the Hold migration card on the first hotkey press after the update
 * changed the user's activation mode, and takes it down on the X or the next
 * press. A hotkey press reaches the pill window as start-dictation (a hold or
 * a hands-free latch) or toggle-dictation (a slot that can only Tap); a click
 * on the pill never goes through IPC and so never counts.
 */
export function useHoldMigrationCard() {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const visibleRef = useRef(false);
  const exitTimerRef = useRef(null);

  const dismiss = useCallback(() => {
    if (!visibleRef.current || exitTimerRef.current) return;
    setExiting(true);
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      visibleRef.current = false;
      setVisible(false);
      setExiting(false);
    }, EXIT_MS);
  }, []);

  useEffect(() => {
    const onPress = () => {
      if (visibleRef.current) {
        dismiss();
        return;
      }
      const state = useSettingsStore.getState();
      if (
        !state.holdMigrationCardPending ||
        state.holdMigrationCardShown ||
        // The card says "hold your hotkey"; a dictation slot demoted to Tap
        // cannot, so it would be teaching a gesture that does not work.
        state.activationMode !== "push"
      ) {
        return;
      }
      state.setHoldMigrationCardShown(true);
      visibleRef.current = true;
      setVisible(true);
    };
    const unsubscribeStart = window.electronAPI?.onStartDictation?.(onPress);
    const unsubscribeToggle = window.electronAPI?.onToggleDictation?.(onPress);
    return () => {
      unsubscribeStart?.();
      unsubscribeToggle?.();
      clearTimeout(exitTimerRef.current);
    };
  }, [dismiss]);

  return { visible: visible && !exiting, exiting, dismiss };
}
```

Note: `visible` is `false` during the 200 ms exit so the window ladder and auto-hide release on dismissal, while `exiting` keeps the card mounted for its fade. App renders the card when `visible || exiting`.

- [ ] **Step 4: Wire the card into `App.jsx` and size the window**

In `src/App.jsx`:

1. After line 27 (`import { HANDS_FREE_TIP_DURATION_MS, resolveHandsFreeTipHotkey } …`) add:

```js
import { HoldMigrationCard } from "./components/dictation/HoldMigrationCard";
import { useHoldMigrationCard } from "./hooks/useHoldMigrationCard";
```

2. Directly above the `useHandsFreeTip({` call (line 299) add:

```js
  const holdMigrationCard = useHoldMigrationCard();
  const holdMigrationCardMounted = holdMigrationCard.visible || holdMigrationCard.exiting;
```

and add `!holdMigrationCard.visible &&` to the tip's `atRest` expression (the tip waits until the card is gone, so the two never stack):

```js
    atRest:
      !isRecording &&
      !isVisuallyProcessing &&
      toastCount === 0 &&
      !isCommandMenuOpen &&
      !assistant.mounted &&
      !liveTranscript.mounted &&
      !holdMigrationCard.visible,
```

3. Replace line 310 with a shared placement flag:

```js
  const tipCardVisible = handsFreeTip.tip !== null || holdMigrationCard.visible;
  const tipCardInPlaceOfPill = tipCardVisible && floatingIconAutoHide;
```

and rename the two later uses of `handsFreeTipInPlaceOfPill` (the pill wrapper class at the `assistant-pill-presence` div and the tip card's `inPlaceOfPill` prop) to `tipCardInPlaceOfPill`.

4. Line 318: `handsFreeTipVisible: tipCardVisible,` (both cards share the `HANDS_FREE_TIP` ladder entry, so `windowSizeLadder.js` and its test stay unchanged).

5. In the auto-hide effect (line 381 onward) add `!holdMigrationCard.visible &&` after `handsFreeTip.tip === null &&`, and add `holdMigrationCard.visible` to the effect's dependency array.

6. In the render, directly after the `{handsFreeTip.tip && ( <HandsFreeTipCard … /> )}` block (ends at line 755) add:

```jsx
        {holdMigrationCardMounted && !anyPanelMounted && (
          <HoldMigrationCard
            hotkey={resolveHandsFreeTipHotkey("dictation", {
              dictationKey: hotkey,
              voiceAgentKey,
              translationKey,
            })}
            align={panelStartPosition === "center" ? "center" : voiceHorizontalDirection}
            inPlaceOfPill={tipCardInPlaceOfPill}
            exiting={holdMigrationCard.exiting}
            onDismiss={holdMigrationCard.dismiss}
            onMouseEnter={() => setWindowInteractivity(true)}
            onMouseLeave={() => {
              if (!isCommandMenuOpen && !assistant.mounted) {
                setWindowInteractivity(false);
              }
            }}
          />
        )}
```

`anyPanelMounted` is declared later in the component today (around line 481); move the two lines `const anyPanelOpen = …; const anyPanelMounted = …;` up to just after the `liveTranscript` hook result (after line ~229) so the render can use them — they depend only on `assistant` and `liveTranscript`.

7. In `src/helpers/windowConfig.js` lines 140–142, the card is four body lines taller than the tip: chip 24 + 14 + title 22 + 4 + two 15 px paragraphs at two lines each (≈ 84) + 4 + 40 padding ≈ 192 px of card, plus the 8 px gap, the 40 px pill and the two 12 px dock insets ≈ 264 px. Set:

```js
  // The hands-free tip card and the Hold migration card (both 320px wide,
  // TIP_CARD_WIDTH) above the docked pill, inside the same 12px dock insets.
  // Tall enough for the migration card's two body lines; the extra headroom
  // above the shorter tip is click-through.
  HANDS_FREE_TIP: { width: 344, height: 288 },
```

Measure on the rig in Task 8 (Step 3) and adjust if the card's `offsetHeight` + 72 exceeds this.

- [ ] **Step 5: Run the tests and the checks**

Run: `npm test -- test/components/holdMigrationCard.test.js test/hooks/useHoldMigrationCard.test.js test/hooks/useHandsFreeTip.test.js test/utils/windowSizeLadder.test.js`
Expected: all pass.

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/dictation/HoldMigrationCard.tsx src/hooks/useHoldMigrationCard.js src/App.jsx src/helpers/windowConfig.js test/components/holdMigrationCard.test.js test/hooks/useHoldMigrationCard.test.js
git commit -m "feat(dictation): one-time Hold migration card on the first hotkey press after the update

Users whose hotkey moved from Tap to Hold see a card above the pill the
first time they press it: what changed and how to hold, plus the double
press for hands-free. No button; the X or the next press dismisses it.
Fresh installs and users already on Hold never see it."
```

---

### Task 8: Full verification, testbook extension, PR update

**Files:**
- No source changes expected (fixes found here go into their own `fix(…)` commits).
- The #1978 testbook artifact (https://claude.ai/code/artifact/76e410b9-7b55-461e-93b1-0eb173774531) extended per spec §4.

- [ ] **Step 1: Run the whole suite and the checks**

Run: `npm test 2>&1 | tail -20 && npm run typecheck && npm run lint && npm run i18n:check`
Expected: every test passes except the one known environmental failure (`settingsStore imports without a bare localStorage global`, Node 25 only); typecheck, lint and i18n clean.

- [ ] **Step 2: Stand the branch up on the rig**

Use the `openwhispr-dev-build` skill to run this worktree's head as a dev build on a throwaway channel profile (hotkeys rebound to F13–F16). Three profiles, prepared before each launch:

- **Upgrade from a Tap profile:** in the profile's `.env` set `ACTIVATION_MODE=tap` and remove any `ACTIVATION_MODE_HOLD_MIGRATED` line; in the pill window's `localStorage` (over CDP, `localStorage.setItem`) set `activationMode=tap`, `onboardingCompleted=true`, and remove `activationModeHoldMigration`, `holdMigrationCardPending`, `holdMigrationCardShown`. Relaunch. Expect: Settings shows the two gesture rows under the dictation hotkey; the first F13 press shows the card with the F13 keycap; a second press dismisses it; a relaunch never shows it again.
- **Upgrade from a Hold profile:** same, with `push` stored. Expect: rows, no card.
- **Fresh install:** empty profile, complete onboarding. Expect: Hold default, no card at any point.

Also, in the Tap profile, press the X instead of a second press on one run.

- [ ] **Step 3: Measure the card and confirm the window size**

With the card visible, over CDP read `document.querySelector(".hands-free-tip-card").offsetHeight`. `WINDOW_SIZES.HANDS_FREE_TIP.height` must be ≥ that value + 72 (8 px gap + 40 px pill + two 12 px insets) with the card not clipped at the top; if not, adjust `windowConfig.js` in a `fix(dictation): size the tip window for the migration card` commit.

- [ ] **Step 4: Linux "cannot Hold" row**

On a Linux backend that cannot Hold for a slot (Hyprland for the assistant slot is the deterministic case: `supportsPushToTalk` returns false for non-dictation slots there), confirm the single `Press to start, press again to stop` row plus the `holdUnsupportedOnHyprland` reason line. If no Linux rig is reachable, record the gap in the testbook as untested on Linux rather than claiming it — Saket's track L is the existing gate for Linux.

- [ ] **Step 5: Extend the testbook and update the PR**

Use the `openwhispr-pr-testbook` skill to add a "Hold-only" track to the #1978 testbook: the three profile scenarios, the gesture rows (macOS; Linux cannot-Hold), the card's two dismissals, and the hotkey-change promotion (demote a slot with a modifier-only combo on a DE-native Linux backend, then pick `F9` → the slot returns to Hold and the rows follow). Update the PR #1978 description with a short "Hold is the only model" section explaining, for a non-technical reader, what changed and why the card exists. Push. Do not merge.

- [ ] **Step 6: Commit and push**

```bash
git push origin feature/hotkey-activation-modes
```

Report back to Josh with: the head SHA, the test counts, what was verified on the rig, and what remains untested (Linux, Windows).

---

## Self-review against the spec (done while writing)

- §2 item 1 (default `push`, both sides): Tasks 1 and 2.
- §2 item 2 (one-time migration, both sides, marker, unsupported slots stay `tap` and Settings says why): Tasks 1, 2, 3 (promotion back is the "prefer push, let demoteHold decide" rule applied at every registration — an interpretation flagged for Josh's review: without it, a slot demoted once could never return to Hold), 6.
- §2 item 3 (remove the choice, keep selector for onboarding, keep setters/IPC): Task 6.
- §2 item 4 (two gesture rows, tap-only row + reason, meeting unchanged, locale keys, ten locales in English): Tasks 4, 6.
- §2 item 5 (card: once, first press, only after a change, chrome from the tip card, copy, no button, X or next press, `holdMigrationCardShown`, tip-card ladder entry): Tasks 5, 7.
- §2 "Relation to #1992": #1992 is already folded into this branch (head `327c4670` under the spec commit), so the new commits go on `feature/hotkey-activation-modes` and #1978 is the single PR.
- §4 unit: migration test (tap→push, marker, second run no-op) in Task 1 and Task 2; `pressGesture.test.js` and `windowSizeLadder.test.js` untouched. Testbook extension in Task 8.
- Placeholder scan: every step carries the code or the exact command.
- Type consistency: `holdMigrationCardPending` / `holdMigrationCardShown` / `setHoldMigrationCardShown` (Tasks 1, 7); `HotkeyKeycaps`, `TipCardShell`, `TIP_CARD_WIDTH` (Tasks 5, 6, 7); `reconcileSlotActivationMode` (Task 3); `tipCardVisible` / `tipCardInPlaceOfPill` (Task 7).
