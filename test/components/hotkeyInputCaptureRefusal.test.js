const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

// Capture mode asks main to release every shortcut before the field may read
// keys. That call used to be fire-and-forget, so a release the desktop refused
// left the field recording chords while the old shortcuts were still firing:
// the keystroke started a recording AND got bound. The field now waits for the
// answer and refuses the capture.

function keyEvent(type, init) {
  return {
    type,
    key: init.key,
    code: init.code ?? init.key,
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    altKey: Boolean(init.altKey),
    shiftKey: Boolean(init.shiftKey),
    bubbles: true,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  };
}

const captureSurface = (root) =>
  findElement(root, (element) => element.getAttribute?.("role") === "button");

async function mountInput(t, { listeningResult, enter, platform = "win32", globe }) {
  const calls = [];
  // Registered before installBrowserGlobals, so the unmount still has a window
  // to tear down against: after-hooks run in registration order.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => platform,
        // main's own Globe listener, not a DOM event: the component subscribes
        // to it while capturing on macOS.
        onGlobeKeyPressed: (callback) => {
          if (globe) globe.down = callback;
          return () => {};
        },
        onGlobeKeyReleased: (callback) => {
          if (globe) globe.up = callback;
          return () => {};
        },
        setHotkeyListeningMode: (enabled) => {
          calls.push(enabled);
          if (!enabled) return Promise.resolve({ success: true });
          // `enter` lets a test hold the answer back, or reject it.
          return enter ? enter() : Promise.resolve(listeningResult);
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hotkey-capture-refusal-test-",
    mockModules: {
      "/i18n": `export default { t: (key) => key };`,
    },
  });
  const { HotkeyInput } = await vite.ssrLoadModule("/components/ui/HotkeyInput.tsx");

  const changes = [];
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(HotkeyInput, {
        value: "F8",
        onChange: (next) => changes.push(next),
      })
    )
  );

  const surface = captureSurface(container);
  assert.ok(surface, "the capture surface rendered");
  // The fake DOM has no focus model; the field blurs itself after a chord.
  surface.focus = () => {};
  surface.blur = () => surface.dispatchEvent({ type: "focusout", bubbles: true });
  return { container, surface, calls, changes };
}

// React delegates onFocus through focusin, which is the event the real field
// receives when the user tabs or clicks into it.
async function focus(surface) {
  await React.act(async () => {
    surface.dispatchEvent({ type: "focusin", bubbles: true, target: surface });
    await new Promise((resolve) => setImmediate(resolve));
  });
}

async function pressF9(surface) {
  await React.act(async () => {
    surface.dispatchEvent(keyEvent("keydown", { key: "F9" }));
  });
  await React.act(async () => {
    surface.dispatchEvent(keyEvent("keyup", { key: "F9" }));
  });
}

test("a chord is recorded once main confirms the shortcuts were released", async (t) => {
  const { surface, calls, changes } = await mountInput(t, {
    listeningResult: { success: true },
  });

  await focus(surface);
  assert.deepEqual(calls.filter(Boolean), [true], "the field asked main to release the shortcuts");

  await pressF9(surface);

  assert.deepEqual(changes, ["F9"]);
});

test("no chord is recorded when the release was refused", async (t) => {
  const { container, surface, calls, changes } = await mountInput(t, {
    listeningResult: { success: false, reason: "capture_release_failed", degraded: true },
  });

  await focus(surface);
  assert.deepEqual(calls.filter(Boolean), [true]);

  await pressF9(surface);

  assert.deepEqual(changes, [], "the key reached the desktop, so it must not be bound here");
  // And the field says why, rather than looking inert.
  assert.match(container.textContent, /hotkeyInput\.captureUnavailable/);
});

// The window between asking and being told. A chord accepted here is one the
// desktop also acted on, so the field has to start blocked, not end blocked.
test("no chord is recorded while the release is still in flight", async (t) => {
  let release;
  const { surface, changes } = await mountInput(t, {
    enter: () => new Promise((resolve) => (release = resolve)),
  });

  await focus(surface);
  await pressF9(surface);
  assert.deepEqual(changes, [], "the answer had not arrived yet");

  await React.act(async () => {
    release({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await pressF9(surface);

  assert.deepEqual(changes, ["F9"], "and it records once the release is confirmed");
});

test("a rejected release fails closed", async (t) => {
  const { container, surface, changes } = await mountInput(t, {
    enter: () => Promise.reject(new Error("IPC channel closed")),
  });

  await focus(surface);
  await pressF9(surface);

  assert.deepEqual(changes, []);
  assert.match(container.textContent, /hotkeyInput\.captureUnavailable/);
});

// Globe does not arrive through the DOM: main's own listener delivers it. It
// has to obey the same fail-closed contract, or the one key a macOS user is
// most likely to bind is recorded while the desktop still owns it.
test("Globe is refused while the release is in flight, and works once confirmed", async (t) => {
  let release;
  const globe = {};
  const { surface, changes } = await mountInput(t, {
    platform: "darwin",
    globe,
    enter: () => new Promise((resolve) => (release = resolve)),
  });

  await focus(surface);
  assert.equal(typeof globe.down, "function", "the component subscribed to main's Globe listener");

  await React.act(async () => globe.down());
  await React.act(async () => globe.up());
  assert.deepEqual(changes, [], "a Globe press before the answer is not a binding");

  // The press that was ignored must not be finalized by its release either,
  // even though the confirmation landed in between.
  await React.act(async () => {
    release({ success: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  await React.act(async () => globe.up());
  assert.deepEqual(changes, [], "and its release does not bind it afterwards");

  // A fresh press, now that the shortcuts are confirmed released, does.
  await React.act(async () => globe.down());
  await React.act(async () => globe.up());
  assert.deepEqual(changes, ["GLOBE"]);
});

test("Globe is refused outright when the release was refused", async (t) => {
  const globe = {};
  const { surface, changes } = await mountInput(t, {
    platform: "darwin",
    globe,
    listeningResult: { success: false, reason: "capture_release_failed", degraded: true },
  });

  await focus(surface);
  await React.act(async () => globe.down?.());
  await React.act(async () => globe.up?.());

  assert.deepEqual(changes, []);
});
