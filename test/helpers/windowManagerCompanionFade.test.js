const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stub set as windowManagerAssistantPanel.test.js: WindowManager pulls in
// electron + sibling managers at require time. The BrowserWindow fake is the
// fuller shape (fix round 1, finding 2's test needs a real closed/did-finish-load
// lifecycle, not just a hand-built fakePillWindow()) — mirrors
// windowManagerAssistantPanel.test.js's own FakeBrowserWindow.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        on: () => undefined,
      },
      BrowserWindow: class FakeBrowserWindow {
        constructor() {
          this.windowListeners = new Map();
          this.webContentsListeners = new Map();
          this.sent = [];
          this.visible = false;
          this.destroyed = false;
          this.bounds = { x: 0, y: 0, width: 0, height: 0 };
          this.webContents = {
            on: (event, listener) => this.webContentsListeners.set(event, listener),
            send: (channel, payload) => this.sent.push({ channel, payload }),
          };
        }
        on(event, listener) {
          this.windowListeners.set(event, listener);
        }
        isDestroyed() {
          return this.destroyed;
        }
        isVisible() {
          return this.visible;
        }
        showInactive() {
          this.visible = true;
        }
        hide() {
          this.visible = false;
        }
        getBounds() {
          return this.bounds;
        }
        setBounds(nextBounds) {
          this.bounds = nextBounds;
        }
        moveTop() {}
        setContentProtection() {}
        setIgnoreMouseEvents() {}
        loadFile() {
          return Promise.resolve();
        }
        loadURL() {
          return Promise.resolve();
        }
        close() {
          this.destroyed = true;
          this.windowListeners.get("closed")?.();
        }
      },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      cleanup() {}
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      AUTO_END_NOTIFICATION_WINDOW_SIZE: { width: 620, height: 116 },
      getMeetingNotificationWindowSize: () => ({ width: 392, height: 92 }),
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (bounds) => bounds,
        getMainWindowPosition: (_display, size) => ({ x: 0, y: 0, ...size }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (size) => size,
      fitAssistantContentWindowToWorkArea: (height) => ({ width: 466, height }),
      fitDictationErrorWindowToWorkArea: (size) => size,
      fitDictationErrorContentWindowToWorkArea: (height) => ({ width: 466, height }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function fakePillWindow() {
  const sent = [];
  let visible = true;
  return {
    sent,
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: () => {
      visible = false;
    },
    showInactive: () => {
      visible = true;
    },
    moveTop: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

// Fix round 1, finding 1: the original fixture leaned on the constructor
// defaults (_onboardingActive=true, _assistantPanelOpen=false), so
// showAgentDictationPill() always returned at its own guards before ever
// reaching the cancel-a-pending-hide code — the exact state a SHOW must be
// exercised against to prove anything about that code. Set up the state a
// show actually needs to succeed, matching the same pattern
// windowManagerAssistantPanel.test.js's own companion-pill tests use.
function managerWithPill() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };
  manager.agentDictationPillWindow = fakePillWindow();
  manager._agentDictationPillReady = true;
  manager.positionAgentDictationPill = () => undefined;
  manager._applyAgentDictationPillClickThrough = () => undefined;
  return manager;
}

test("the companion pill fades before its window hides, and a show cancels the pending hide", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = managerWithPill();
  const pill = manager.agentDictationPillWindow;

  manager.hideAgentDictationPill();
  assert.equal(pill.sent.at(-1).channel, "agent-dictation-pill-will-hide");
  assert.equal(pill.isVisible(), true, "not hidden yet");

  t.mock.timers.tick(180);
  assert.equal(pill.isVisible(), false);

  pill.showInactive();
  manager.hideAgentDictationPill();
  manager.showAgentDictationPill();
  t.mock.timers.tick(500);
  assert.equal(pill.isVisible(), true, "a show during the fade keeps the window");
  assert.equal(pill.sent.at(-1).channel, "agent-dictation-pill-will-show");
});

// Fix round 1, finding 1 (the real one): proven sequence — panel open with a
// visible ready pill, onboarding starts (scheduling the fade-and-hide),
// THEN a show request arrives (e.g. mainWindow's own "focus" handler, gated
// only on _assistantPanelOpen, which onboarding never clears) while that
// fade is still in flight. A show that the guards go on to REJECT must not
// have already cancelled the pending hide or told the renderer to reverse
// it — otherwise the pill is stranded visible with nothing left to hide it,
// defeating "onboarding suppresses the companion pill like every other
// popup surface" at exactly the moment a stray floating pill is worst.
test("a show blocked by the guards does not cancel a pending hide", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = managerWithPill();
  const pill = manager.agentDictationPillWindow;

  manager.hideAgentDictationPill();
  assert.equal(pill.sent.at(-1).channel, "agent-dictation-pill-will-hide");

  // Onboarding starting mid-fade blocks the show at showAgentDictationPill's
  // own first guard — set directly (not via setOnboardingActive(true)) to
  // isolate exactly the guard under test from that method's other side
  // effects (cancelling dictation, hiding other surfaces).
  manager._onboardingActive = true;
  manager.showAgentDictationPill();
  assert.notEqual(
    pill.sent.at(-1).channel,
    "agent-dictation-pill-will-show",
    "a blocked show must not send will-show"
  );

  t.mock.timers.tick(200);
  assert.equal(
    pill.isVisible(),
    false,
    "the pending hide must still land even though a blocked show ran in between"
  );
});

// Re-verified after the finding-1 fix moved the cancel out of the top of the
// method: an accepted show with nothing pending must stay a no-op (no
// spurious will-show) — the same shape the pre-existing did-finish-load
// test in windowManagerAssistantPanel.test.js already covers via the real
// creation path, checked again here directly against managerWithPill().
test("two shows in a row send will-show only once, from the one that actually cancels something", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = managerWithPill();
  const pill = manager.agentDictationPillWindow;

  manager.hideAgentDictationPill();
  manager.showAgentDictationPill();
  assert.equal(pill.sent.at(-1).channel, "agent-dictation-pill-will-show");
  const sentAfterFirstShow = pill.sent.length;

  // A second show with nothing pending must not repeat it.
  manager.showAgentDictationPill();
  assert.equal(
    pill.sent.length,
    sentAfterFirstShow,
    "a second show with no pending hide must not send another will-show"
  );
});

// Re-verified: the pending-timer gate in hideAgentDictationPill must make a
// second hide, while the first is still fading, a pure no-op — not a second
// will-hide, not a second timer racing the first.
test("two hides in a row only fade once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = managerWithPill();
  const pill = manager.agentDictationPillWindow;

  manager.hideAgentDictationPill();
  assert.equal(pill.sent.filter((m) => m.channel === "agent-dictation-pill-will-hide").length, 1);

  manager.hideAgentDictationPill();
  assert.equal(
    pill.sent.filter((m) => m.channel === "agent-dictation-pill-will-hide").length,
    1,
    "a second hide while the first is still pending must not re-arm or resend"
  );

  t.mock.timers.tick(180);
  assert.equal(pill.isVisible(), false, "the one real fade still lands");
});

// Re-verified: a hide with nothing to fade (not visible, or not ready yet)
// must go straight to the immediate native hide, matching the pre-existing
// synchronous behaviour those cases always had.
test("a hide with no pending timer and nothing visible resolves immediately, not via the fade", () => {
  const manager = managerWithPill();
  const pill = manager.agentDictationPillWindow;
  pill.hide();

  manager.hideAgentDictationPill();
  assert.equal(
    pill.sent.some((m) => m.channel === "agent-dictation-pill-will-hide"),
    false,
    "an already-hidden pill has nothing to fade"
  );
  assert.equal(pill.sent.at(-1)?.channel, "preview-hide");
});

// Fix round 1, finding 2: a pending fade-then-hide timer belongs to the
// window it was scheduled for. Exercises the REAL creation path (unlike
// managerWithPill(), which hand-installs a fake pill and never reaches
// showAgentDictationPill's own closed/did-finish-load listeners) so the
// closed handler under test actually runs.
test("a stale pending hide timer from a destroyed pill window never touches its replacement", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const firstPill = manager.agentDictationPillWindow;
  firstPill.webContentsListeners.get("did-finish-load")();
  assert.equal(firstPill.isVisible(), true, "fixture: the first pill is up and visible");

  manager.hideAgentDictationPill();
  assert.equal(firstPill.sent.at(-1).channel, "agent-dictation-pill-will-hide");

  // The window is destroyed (crash / recreate) while the fade timer is
  // still pending — the "closed" listener fires synchronously here.
  firstPill.close();
  assert.equal(manager.agentDictationPillWindow, null, "fixture: closed cleared the slot");

  // A replacement window takes over — deliberately NOT marked ready via its
  // own did-finish-load. That path recursively calls showAgentDictationPill()
  // again, which would route through THIS finding's own ready-path
  // cancel-a-pending-hide check (finding 1's fix) and incidentally clear the
  // stale timer there — masking finding 2 behind finding 1 instead of
  // isolating it. Poke the ready/visible state directly so nothing but the
  // "closed" handler under test can have cleared the stale timer.
  manager.showAgentDictationPill();
  const secondPill = manager.agentDictationPillWindow;
  assert.notEqual(secondPill, firstPill, "fixture: a genuinely new window");
  manager._agentDictationPillReady = true;
  secondPill.showInactive();
  const sentBeforeTick = secondPill.sent.length;

  // If the first window's stale timer survived, it fires here and runs
  // _hideAgentDictationPillNow() against whatever agentDictationPillWindow
  // now points at — the SECOND, live, visible window — sending it a stray
  // "preview-hide" and hiding it.
  t.mock.timers.tick(500);
  assert.equal(
    secondPill.sent.length,
    sentBeforeTick,
    "the destroyed window's pending hide must never reach its replacement"
  );
  assert.equal(secondPill.isVisible(), true, "the replacement must stay visible");
});

// Fix round 1, finding 3: bind the two copies of the same duration together
// so a retune of one without the other — the exact duplicated-literal class
// of regression this plan has already cost fix rounds on (Tasks 2, 5, 6) —
// fails a test instead of silently desyncing the native hide from the CSS
// fade. windowManager.js is main-process code with no import path into the
// renderer-only springEasing.ts, so this is the binding: a test that can see
// both.
test("AGENT_DICTATION_PILL_FADE_MS stays bound to MOTION_TIMING.companionFadeMs", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  assert.equal(WindowManager.AGENT_DICTATION_PILL_FADE_MS, MOTION_TIMING.companionFadeMs);
});
