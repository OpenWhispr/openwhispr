// Task 9's renderer half: the pill "zoops" out (scale into its own centre)
// and the native window only hides once that has finished. These tests drive
// the real orderings the plan's earlier reviews found bugs in — a hide during
// a hide, a show during a zoop, a recording start during a zoop, a hide when
// the pill is already exited, a refused hide, and reduced motion (where the
// transform transitionend the choreography waits on can STRUCTURALLY never
// fire, because src/index.css's blanket reduced-motion rule strips transform
// from transition-property with !important).
const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function fakePresence() {
  const listeners = new Set();
  return {
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    settleProperty(propertyName) {
      for (const fn of [...listeners]) fn({ target: this, propertyName });
    },
    settle() {
      this.settleProperty("transform");
    },
  };
}

async function mount(t, { reducedMotion = false, hideWindowRejects = false } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const hideCalls = [];
  installBrowserGlobals(t, {
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      electronAPI: {
        hideWindow: async () => {
          hideCalls.push(Date.now());
          if (hideWindowRejects) {
            throw new Error("No handler registered for 'hide-window'");
          }
        },
        onPillWillHide: (cb) => {
          listeners.willHide = cb;
          return () => {
            listeners.willHide = null;
          };
        },
        onPillWillShow: (cb) => {
          listeners.willShow = cb;
          return () => {
            listeners.willShow = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  // installHookDom's document listeners are no-ops; give this file a real
  // registry so the visibilitychange path (and its cleanup) can be driven.
  const documentListeners = new Map();
  globalThis.document.addEventListener = (type, fn) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(fn);
  };
  globalThis.document.removeEventListener = (type, fn) => {
    documentListeners.get(type)?.delete(fn);
  };
  globalThis.document.visibilityState = "hidden";
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-pill-exit-test-" });
  const { usePillExitChoreography } = await vite.ssrLoadModule("/hooks/usePillExitChoreography.js");
  const presence = fakePresence();
  const pillPresenceRef = { current: presence };
  let result;
  let props = { recording: false };
  function Harness() {
    result = usePillExitChoreography({ pillPresenceRef, recording: props.recording });
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  await render();
  const fireDocument = (type) => {
    for (const fn of [...(documentListeners.get(type) ?? [])]) fn({ type });
  };
  return {
    render,
    presence,
    listeners,
    hideCalls,
    documentListeners,
    fireDocument,
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
    read: () => result,
  };
}

test("hideWithZoop plays the exit, then hides the window, and stays exited until shown", async (t) => {
  const { presence, hideCalls, listeners, read } = await mount(t);
  let done = false;
  let hiding;
  await React.act(async () => {
    hiding = read()
      .hideWithZoop()
      .then(() => (done = true));
  });
  assert.equal(read().exiting, true);
  assert.equal(hideCalls.length, 0, "the window must not hide before the zoop ends");
  await React.act(async () => presence.settle());
  await hiding;
  assert.equal(done, true);
  assert.equal(hideCalls.length, 1);
  assert.equal(read().exiting, true, "hidden pill keeps the exited pose for the unzoop");

  await React.act(async () => listeners.willShow());
  assert.equal(read().exiting, false);
});

test("a main-initiated hide runs the same choreography; a recording start clears the pose", async (t) => {
  const { presence, hideCalls, listeners, render, read } = await mount(t);
  await React.act(async () => listeners.willHide());
  assert.equal(read().exiting, true);
  await React.act(async () => presence.settle());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hideCalls.length, 1);

  await render({ recording: true });
  assert.equal(read().exiting, false);
});

test("a show DURING the zoop aborts the hide: the window is never hidden and the pill returns", async (t) => {
  const { presence, hideCalls, listeners, read } = await mount(t);
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  assert.equal(read().exiting, true);

  // The show lands mid-zoop. Clearing `exiting` alone is not enough: removing
  // the exit pose REPLACES the running transform transition, which fires
  // transitioncancel — waitForTransitionEnd settles on that, so a hide that
  // only watched the pose would go on to hide the window the user just asked
  // for. (Task 7's review found this exact stranding shape on the companion.)
  let settled;
  await React.act(async () => {
    listeners.willShow();
    presence.settle();
    settled = await hiding;
  });
  assert.equal(read().exiting, false, "the pill must come back, not stay collapsed");
  assert.equal(hideCalls.length, 0, "a cancelled zoop must never hide the window");
  assert.deepEqual(settled, { hidden: false, cancelled: true });
});

test("a recording starting during the zoop aborts the hide as well", async (t) => {
  const { presence, hideCalls, render, read } = await mount(t);
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  await render({ recording: true });
  assert.equal(read().exiting, false);

  let settled;
  await React.act(async () => {
    presence.settle();
    settled = await hiding;
  });
  assert.equal(hideCalls.length, 0, "a recording must keep its own window");
  assert.equal(settled.cancelled, true);
});

test("the window becoming visible again aborts a pending exit, and the listener is removed on unmount", async (t) => {
  const { presence, hideCalls, fireDocument, documentListeners, unmount, read } = await mount(t);
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  globalThis.document.visibilityState = "visible";
  let settled;
  await React.act(async () => {
    fireDocument("visibilitychange");
    presence.settle();
    settled = await hiding;
  });
  assert.equal(read().exiting, false);
  assert.equal(hideCalls.length, 0);
  assert.equal(settled.cancelled, true);

  assert.equal(documentListeners.get("visibilitychange")?.size, 1);
  await unmount();
  assert.equal(documentListeners.get("visibilitychange")?.size ?? 0, 0);
});

test("a second hide while one is in flight reuses it instead of queueing a second window hide", async (t) => {
  const { presence, hideCalls, read } = await mount(t);
  let first;
  let second;
  await React.act(async () => {
    first = read().hideWithZoop();
    second = read().hideWithZoop();
  });
  assert.equal(first, second, "an in-flight exit is reused, not restarted");
  await React.act(async () => presence.settle());
  await first;
  assert.equal(hideCalls.length, 1);
});

test("a hide right after a cancelled exit starts a fresh one instead of adopting the cancelled promise", async (t) => {
  const { presence, hideCalls, listeners, read } = await mount(t);
  let first;
  await React.act(async () => {
    first = read().hideWithZoop();
  });
  await React.act(async () => listeners.willShow());

  // The show is immediately followed by another hide (a tray toggle, a fast
  // double press). Reusing the cancelled exit here would return a promise
  // that can never hide the window — the pill would zoop out and stay there.
  let second;
  await React.act(async () => {
    second = read().hideWithZoop();
  });
  assert.notEqual(second, first, "a cancelled exit must not be adopted by the next hide");
  await React.act(async () => {
    presence.settle();
    await Promise.all([first, second]);
  });
  assert.equal(hideCalls.length, 1, "only the live exit hides the window");
});

test("a hide requested while the pill is already exited hides at once — there is no transition left to wait for", async (t) => {
  const { presence, hideCalls, read } = await mount(t);
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  await React.act(async () => presence.settle());
  await hiding;
  assert.equal(hideCalls.length, 1);
  assert.equal(read().exiting, true);

  // No presence.settle() here on purpose: the pill is already collapsed, so
  // re-entering the same pose starts no transition and nothing would ever
  // settle. Deliberately NOT awaiting the returned promise either — the
  // fallback timer would eventually resolve it and hide the arrival of this
  // one look identical to a wait. hideWindow is called synchronously when
  // there is nothing to wait for, so the count right here is the proof.
  let second = null;
  await React.act(async () => {
    void read()
      .hideWithZoop()
      .then((result) => (second = result));
  });
  assert.equal(hideCalls.length, 2, "an already-collapsed pill must hide without waiting");
  await React.act(async () => {});
  assert.deepEqual(second, { hidden: true, cancelled: false });
});

test("reduced motion hides without waiting for a transform transitionend that can never fire", async (t) => {
  const { hideCalls, read } = await mount(t, { reducedMotion: true });
  // src/index.css forces transition-property to a list that excludes
  // transform under reduced motion, so there is no transform transition and
  // no transitionend. Waiting would strand the window up for the whole
  // fallback window (Task 3 lost a round to exactly this shape).
  //
  // The promise is deliberately NOT awaited: the fallback timer resolves it
  // either way, so awaiting would make "hid at once" and "hid 320ms later"
  // indistinguishable. hideWindow is called synchronously when nothing is
  // waited on, so the count right here is the proof.
  let settled = null;
  await React.act(async () => {
    void read()
      .hideWithZoop()
      .then((result) => (settled = result));
  });
  assert.equal(hideCalls.length, 1, "reduced motion must not wait on an impossible transitionend");
  await React.act(async () => {});
  assert.deepEqual(settled, { hidden: true, cancelled: false });
  assert.equal(read().exiting, true);
});

test("a refused or unhandled hide brings the pill back instead of stranding it invisible", async (t) => {
  const { presence, read } = await mount(t, { hideWindowRejects: true });
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  let settled;
  await React.act(async () => {
    presence.settle();
    settled = await hiding;
  });
  assert.equal(
    read().exiting,
    false,
    "a window that is staying up must not keep an invisible pill"
  );
  assert.deepEqual(settled, { hidden: false, cancelled: false });
});

test("the exit waits on the wrapper's own TRANSFORM — the opacity half settling early must not end it", async (t) => {
  const { presence, hideCalls, read } = await mount(t);
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop();
  });
  // The real zoop rule transitions opacity too (80ms after a 120ms delay).
  // Settling on whichever property happens to finish first would hide the
  // window mid-collapse.
  await React.act(async () => presence.settleProperty("opacity"));
  assert.equal(hideCalls.length, 0);

  await React.act(async () => presence.settle());
  await hiding;
  assert.equal(hideCalls.length, 1);
});

test("a zoop that never settles falls back on Task 1's pinned zoop timing, not a retyped number", async (t) => {
  const { hideCalls, read } = await mount(t);
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { settleFallbackMs } = await import("../../src/utils/transitionSettled.ts");
  const fallbackMs = settleFallbackMs(MOTION_TIMING.zoopMs);

  // Timers are mocked only AFTER mount: the Vite SSR server the harness
  // starts needs real ones.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let hiding;
    await React.act(async () => {
      hiding = read().hideWithZoop();
    });
    t.mock.timers.tick(fallbackMs - 1);
    await React.act(async () => {});
    assert.equal(hideCalls.length, 0, "the fallback must not fire before the pinned window");
    t.mock.timers.tick(1);
    await React.act(async () => {
      await hiding;
    });
    assert.equal(hideCalls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});
