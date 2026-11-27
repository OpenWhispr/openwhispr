const test = require("node:test");
const assert = require("node:assert/strict");

const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");
const { deferred } = require("./harness/deferred");
const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};

test.beforeEach(() => {
  registered.clear();
});

function withSessionType(type, fn) {
  return async () => {
    const saved = process.env.XDG_SESSION_TYPE;
    process.env.XDG_SESSION_TYPE = type;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE = saved;
    }
  };
}

const { REGISTRATION } = require("../../src/helpers/gnomeGlobalShortcutsPortal");

function approvalStore(state = null) {
  return {
    state,
    read() {
      return this.state;
    },
    write(next) {
      this.state = next;
    },
  };
}

// `outcomes` answers each portal bind in turn, as a value or a function of the
// bind's trigger and callback.
function gnomeManagerWithPortal(
  outcomes,
  { approval = approvalStore("approved"), portalAvailable = true } = {}
) {
  const manager = new GnomeShortcutManager();
  const portal = { triggers: [], unregisters: 0 };
  manager.globalShortcutsPortal.isAvailable = () => portalAvailable;
  manager.cancelShortcutApproval = approval;
  manager.cancelShortcutsPortal = {
    registerKeybinding(trigger, callback) {
      portal.triggers.push(trigger);
      const outcome = outcomes[portal.triggers.length - 1] ?? REGISTRATION.BOUND;
      return Promise.resolve(typeof outcome === "function" ? outcome(trigger, callback) : outcome);
    },
    async unregisterKeybinding() {
      portal.unregisters += 1;
    },
  };
  return { manager, portal, approval };
}

test(
  "a recording binds Escape through the portal only once GNOME approved it",
  withSessionType("wayland", async () => {
    for (const state of [null, "declined"]) {
      const { manager, portal } = gnomeManagerWithPortal([], { approval: approvalStore(state) });
      assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
      assert.deepEqual(portal.triggers, []);
    }

    let cancels = 0;
    const { manager, portal } = gnomeManagerWithPortal([
      (_trigger, callback) => {
        callback(undefined, "down");
        callback(undefined, "up");
        return REGISTRATION.BOUND;
      },
    ]);
    assert.equal(await manager.registerCancelShortcut("Escape", () => cancels++), true);
    assert.deepEqual(portal.triggers, ["Escape"]);
    assert.equal(cancels, 1);

    await manager.unregisterCancelShortcut();
    assert.equal(portal.unregisters, 1);
  })
);

test(
  "the approval request binds once, records the approval and closes the session",
  withSessionType("wayland", async () => {
    const { manager, portal, approval } = gnomeManagerWithPortal([], {
      approval: approvalStore(null),
    });

    assert.equal(await manager.requestCancelShortcutApproval("Escape"), true);
    assert.equal(approval.state, "approved");
    assert.equal(portal.unregisters, 1);

    assert.equal(await manager.requestCancelShortcutApproval("Escape"), false);
    assert.deepEqual(portal.triggers, ["Escape"]);
  })
);

test(
  "a declined approval is remembered across restarts",
  withSessionType("wayland", async () => {
    const approval = approvalStore(null);
    const { manager, portal } = gnomeManagerWithPortal([REGISTRATION.DECLINED], { approval });

    assert.equal(await manager.requestCancelShortcutApproval("Escape"), false);
    assert.equal(approval.state, "declined");

    const restarted = gnomeManagerWithPortal([], { approval });
    assert.equal(await restarted.manager.requestCancelShortcutApproval("Escape"), false);
    assert.equal(await restarted.manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual([...portal.triggers, ...restarted.portal.triggers], ["Escape"]);
  })
);

test(
  "an approval request cut short by quitting is neither kept nor latched",
  withSessionType("wayland", async () => {
    const { manager, portal, approval } = gnomeManagerWithPortal([REGISTRATION.SUPERSEDED], {
      approval: approvalStore(null),
    });

    assert.equal(await manager.requestCancelShortcutApproval("Escape"), false);
    assert.equal(approval.state, null);
    assert.equal(await manager.requestCancelShortcutApproval("Escape"), true);
    assert.deepEqual(portal.triggers, ["Escape", "Escape"]);
  })
);

test(
  "a portal failure stops cancel binding until restart without being saved",
  withSessionType("wayland", async () => {
    const approval = approvalStore("approved");
    const { manager, portal } = gnomeManagerWithPortal([REGISTRATION.FAILED], { approval });

    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(portal.triggers, ["Escape"]);
    assert.equal(approval.state, "approved");

    const restarted = gnomeManagerWithPortal([], { approval });
    assert.equal(await restarted.manager.registerCancelShortcut("Escape", noop), true);
  })
);

test(
  "a recording declined after GNOME forgot the approval is not asked again",
  withSessionType("wayland", async () => {
    const { manager, portal, approval } = gnomeManagerWithPortal([REGISTRATION.DECLINED]);

    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.equal(approval.state, "declined");
    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(portal.triggers, ["Escape"]);
  })
);

test(
  "a cancel binding superseded by its recording ending is tried again next time",
  withSessionType("wayland", async () => {
    let finishFirst;
    const { manager, portal, approval } = gnomeManagerWithPortal([
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    ]);

    const first = manager.registerCancelShortcut("Escape", noop);
    await manager.unregisterCancelShortcut();
    finishFirst(REGISTRATION.SUPERSEDED);
    assert.equal(await first, false);

    assert.equal(await manager.registerCancelShortcut("Escape", noop), true);
    assert.deepEqual(portal.triggers, ["Escape", "Escape"]);
    assert.equal(approval.state, "approved");
  })
);

test(
  "a recording while the approval dialog is open neither binds nor closes the dialog",
  withSessionType("wayland", async () => {
    let answer;
    const { manager, portal, approval } = gnomeManagerWithPortal(
      [
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ],
      { approval: approvalStore(null) }
    );

    const request = manager.requestCancelShortcutApproval("Escape");
    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);
    await manager.unregisterCancelShortcut();
    assert.equal(portal.unregisters, 0);

    answer(REGISTRATION.BOUND);
    assert.equal(await request, true);
    assert.equal(approval.state, "approved");
    assert.equal(await manager.registerCancelShortcut("Escape", noop), true);
    assert.deepEqual(portal.triggers, ["Escape", "Escape"]);
  })
);

test(
  "a second approval request while the dialog is open leaves it alone",
  withSessionType("wayland", async () => {
    let answer;
    const { manager, portal } = gnomeManagerWithPortal(
      [
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ],
      { approval: approvalStore(null) }
    );

    const first = manager.requestCancelShortcutApproval("Escape");
    assert.equal(await manager.requestCancelShortcutApproval("Escape"), false);
    assert.deepEqual(portal.triggers, ["Escape"]);

    answer(REGISTRATION.BOUND);
    assert.equal(await first, true);
  })
);

test(
  "a recording while the approved session is still closing does not bind",
  withSessionType("wayland", async () => {
    const { manager, portal, approval } = gnomeManagerWithPortal([], {
      approval: approvalStore(null),
    });
    const closing = deferred();
    manager.cancelShortcutsPortal.unregisterKeybinding = () => closing.promise;

    const request = manager.requestCancelShortcutApproval("Escape");
    await new Promise(setImmediate);
    assert.equal(approval.state, "approved");
    assert.equal(await manager.registerCancelShortcut("Escape", noop), false);

    closing.resolve();
    assert.equal(await request, true);
    assert.deepEqual(portal.triggers, ["Escape"]);
  })
);

test(
  "a finished recording does not block asking again after Hold cleared the approval",
  withSessionType("wayland", async () => {
    const { manager, portal, approval } = gnomeManagerWithPortal([]);

    assert.equal(await manager.registerCancelShortcut("Escape", noop), true);
    await manager.unregisterCancelShortcut();
    approval.write(null);

    assert.equal(await manager.requestCancelShortcutApproval("Escape"), true);
    assert.deepEqual(portal.triggers, ["Escape", "Escape"]);
  })
);

test(
  "the GNOME cancel shortcut is never bound on X11 or without the portal",
  withSessionType("x11", async () => {
    const onX11 = gnomeManagerWithPortal([], { approval: approvalStore(null) });
    assert.equal(await onX11.manager.requestCancelShortcutApproval("Escape"), false);
    onX11.manager.cancelShortcutApproval.state = "approved";
    assert.equal(await onX11.manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(onX11.portal.triggers, []);

    process.env.XDG_SESSION_TYPE = "wayland";
    const noPortal = gnomeManagerWithPortal([], {
      approval: approvalStore(null),
      portalAvailable: false,
    });
    assert.equal(await noPortal.manager.requestCancelShortcutApproval("Escape"), false);
    noPortal.manager.cancelShortcutApproval.state = "approved";
    assert.equal(await noPortal.manager.registerCancelShortcut("Escape", noop), false);
    assert.deepEqual(noPortal.portal.triggers, []);
  })
);

test("the GNOME cancel portal binds its own shortcut and closes with the manager", async () => {
  const manager = new GnomeShortcutManager();
  assert.equal(manager.cancelShortcutsPortal.shortcutId, "cancel");
  assert.equal(manager.cancelShortcutsPortal.descriptionKey, "app.buttons.cancelRecording");

  const closed = [];
  manager.globalShortcutsPortal.close = async () => closed.push("dictation");
  manager.cancelShortcutsPortal.close = async () => closed.push("cancel");
  await manager.close();
  assert.deepEqual(closed, ["dictation", "cancel"]);
});

function holdManager(outcome, approval) {
  const manager = new GnomeShortcutManager();
  const tapBindings = [];
  manager.cancelShortcutApproval = approval;
  manager.unregisterKeybinding = async () => true;
  manager.registerKeybinding = async (shortcut) => {
    tapBindings.push(shortcut);
    return true;
  };
  manager.globalShortcutsPortal.registerKeybinding = async () => outcome;
  return { manager, tapBindings };
}

test("a Hold binding makes the cancel shortcut need approval again", async () => {
  for (const state of ["approved", "declined"]) {
    const approval = approvalStore(state);
    const { manager, tapBindings } = holdManager(REGISTRATION.BOUND, approval);

    assert.equal(await manager.registerPushToTalk("Alt+R", noop), true);
    assert.equal(approval.state, null);
    assert.deepEqual(tapBindings, []);
  }
});

test("a superseded Hold binding leaves no tap fallback behind", async () => {
  const approval = approvalStore("approved");
  const { manager, tapBindings } = holdManager(REGISTRATION.SUPERSEDED, approval);

  assert.equal(await manager.registerPushToTalk("Alt+R", noop), false);
  assert.deepEqual(tapBindings, []);
  assert.equal(approval.state, "approved");
});

function hotkeyManagerOnGnome(activationMode) {
  const calls = [];
  const manager = new HotkeyManager();
  manager.useGnome = true;
  manager.activationMode = activationMode;
  manager.gnomeManager = {
    async registerCancelShortcut(hotkey, callback) {
      calls.push(["register", hotkey, callback]);
      return false;
    },
    async unregisterCancelShortcut() {
      calls.push(["unregister"]);
    },
    async requestCancelShortcutApproval(hotkey) {
      calls.push(["approval", hotkey]);
      return true;
    },
  };
  return { manager, calls };
}

test("in Tap mode on GNOME, cancel keeps its X11 grab and also tries the portal", async () => {
  const { manager, calls } = hotkeyManagerOnGnome("tap");
  const callback = () => {};

  assert.equal((await manager.registerSlot("cancel", "Escape", callback)).success, true);
  assert.ok(registered.has("Escape"));
  assert.deepEqual(calls, [["register", "Escape", callback]]);

  manager.unregisterSlot("cancel");
  assert.equal(registered.has("Escape"), false);
  assert.deepEqual(calls.at(-1), ["unregister"]);
});

test("in Hold mode on GNOME, cancel stays on the X11 grab alone", async () => {
  const { manager, calls } = hotkeyManagerOnGnome("push");

  assert.equal((await manager.registerSlot("cancel", "Escape", noop)).success, true);
  assert.ok(registered.has("Escape"));
  assert.deepEqual(calls, []);
  manager.unregisterSlot("cancel");
});

test("cancel skips the portal when its X11 grab fails, so nothing is left to release", async () => {
  const { manager, calls } = hotkeyManagerOnGnome("tap");
  registered.set("Escape", noop);

  assert.equal((await manager.registerSlot("cancel", "Escape", noop)).success, false);
  assert.deepEqual(calls, []);
});

test("the GNOME cancel approval is requested for Escape in Tap mode only", async () => {
  const tap = hotkeyManagerOnGnome("tap");
  assert.equal(await tap.manager.requestGnomeCancelShortcutApproval(), true);
  assert.deepEqual(tap.calls, [["approval", "Escape"]]);

  const hold = hotkeyManagerOnGnome("push");
  assert.equal(await hold.manager.requestGnomeCancelShortcutApproval(), false);
  assert.deepEqual(hold.calls, []);

  const offGnome = hotkeyManagerOnGnome("tap");
  offGnome.manager.useGnome = false;
  assert.equal(await offGnome.manager.requestGnomeCancelShortcutApproval(), false);
  assert.deepEqual(offGnome.calls, []);
});
