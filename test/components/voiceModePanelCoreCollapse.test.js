// Covers the new onCollapsed signal in VoiceModePanelCore.tsx (Task 7): the
// shell reports its own clip-path transitionend — but ONLY while genuinely
// closing (closing && !open), only in "assistant" mode, only for the
// clip-path property specifically (not the sibling opacity/transform
// properties sharing this element's transition list), and only when the
// event actually originated on the shell itself (event.target ===
// event.currentTarget), not a bubbled descendant. Exercised against the
// REAL component through react-dom's createRoot, dispatching a synthetic
// transitionend through the fake DOM's real addEventListener/dispatchEvent
// contract (installInteractiveDom) so this proves the actual capture-phase
// listener wiring, not a re-implementation of its logic.
//
// One Vite dev server is shared across every test (module-scoped, closed in
// the file's own `after`) instead of one per mount: this component's render
// output depends only on its own props, not on any module-level state, so
// there is nothing a shared server could leak between tests — and starting
// Vite fresh per mount was measured to make this file's run time dominated
// by dev-server bring-up rather than the assertions themselves.
const test = require("node:test");
const { before, after } = test;
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installInteractiveDom,
  findElement,
} = require("../lib/rendererTestHarness");

let vite = null;
let VoiceModePanelCore = null;

before(async () => {
  const cleanup = [];
  const fakeTestContext = { after: (fn) => cleanup.push(fn) };
  vite = await createRendererServer(fakeTestContext, {
    cachePrefix: "openwhispr-voice-mode-panel-core-collapse-test-",
  });
  vite.__cleanup = cleanup;
  ({ VoiceModePanelCore } = await vite.ssrLoadModule(
    "/components/dictation/VoiceModePanelCore.tsx"
  ));
});

after(async () => {
  if (!vite) return;
  for (const fn of vite.__cleanup) await fn();
});

function fakeTransitionEnd({ propertyName }) {
  return {
    type: "transitionend",
    bubbles: true,
    propertyName,
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

async function mountCore(t, props) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(VoiceModePanelCore, { onPreferredHeightChange: () => {}, ...props })
    );
  });
  const shell = findElement(container, (el) =>
    (el.getAttribute("class") || "").includes("expanding-panel-surface")
  );
  assert.ok(shell, "fixture setup: the shell element renders");
  return shell;
}

test("onCollapsed fires when the shell's own clip-path transition ends while genuinely closing", async (t) => {
  let collapsedCalls = 0;
  const onCollapsed = () => {
    collapsedCalls += 1;
  };
  const shell = await mountCore(t, {
    mode: "assistant",
    open: false,
    closing: true,
    onCollapsed,
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(collapsedCalls, 1, "the shell's own clip-path transitionend must fire onCollapsed");
});

test("onCollapsed ignores the sibling opacity/transform properties on the same transition list", async (t) => {
  let collapsedCalls = 0;
  const shell = await mountCore(t, {
    mode: "assistant",
    open: false,
    closing: true,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "opacity" }));
  });
  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "transform" }));
  });
  assert.equal(
    collapsedCalls,
    0,
    "only clip-path may report the collapse — not its sibling properties"
  );
});

test("onCollapsed never fires for live-transcript mode, only assistant", async (t) => {
  let collapsedCalls = 0;
  const shell = await mountCore(t, {
    mode: "live-transcript",
    open: false,
    closing: true,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(
    collapsedCalls,
    0,
    "live-transcript's own collapse must not reuse the assistant close signal"
  );
});

// Split into two tests (rather than two mounts in one) so each gets its own
// installBrowserGlobals/installInteractiveDom lifecycle — two mounts sharing
// one test's cleanup queue interleave their restore-vs-unmount `t.after`
// hooks (registered in FIFO order across both mounts) and the first mount's
// "restore window" can fire before the second mount's own unmount, which is
// exactly the ReferenceError this shape hit before being split.
test("onCollapsed never fires while the panel is genuinely open", async (t) => {
  let collapsedCalls = 0;
  // Open, not closing: gate must hold even if a stray clip-path transitionend
  // lands (e.g. the entrance spring's own settle).
  const openShell = await mountCore(t, {
    mode: "assistant",
    open: true,
    closing: false,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });
  await React.act(async () => {
    openShell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(collapsedCalls, 0, "an open, non-closing shell must never report a collapse");
});

// Neither `!open` nor `mode === "assistant"` alone can distinguish this from
// the two tests above: a rest state (never opened, never closing) also has
// open=false, so this is the only case that isolates the `closing` guard
// itself — dropping `closing` from the condition entirely passed both
// tests above unnoticed during this task's own bite-check pass.
test("onCollapsed never fires for an idle mount that is neither open nor closing", async (t) => {
  let collapsedCalls = 0;
  const idleShell = await mountCore(t, {
    mode: "assistant",
    open: false,
    closing: false,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });
  await React.act(async () => {
    idleShell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(collapsedCalls, 0, "a rest-state shell (never opened) must never report a collapse");
});

test("onCollapsed never fires while closing=true but the panel is still open (a reopen in flight)", async (t) => {
  let collapsedCalls = 0;
  // closing=true but open=true (a reopen raced the close before it settled):
  // must not fire — the brief's own condition is `closing && !open`.
  const reopeningShell = await mountCore(t, {
    mode: "assistant",
    open: true,
    closing: true,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });
  await React.act(async () => {
    reopeningShell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(
    collapsedCalls,
    0,
    "closing while still open (a reopen in flight) must not report a collapse"
  );
});

test("onCollapsed ignores a clip-path transitionend that bubbled up from a descendant, not the shell itself", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  let collapsedCalls = 0;

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        VoiceModePanelCore,
        {
          mode: "assistant",
          open: false,
          closing: true,
          onCollapsed: () => {
            collapsedCalls += 1;
          },
          onPreferredHeightChange: () => {},
        },
        React.createElement("div", { className: "fake-descendant" })
      )
    );
  });
  const child = findElement(container, (el) => (el.getAttribute("class") || "") === "fake-descendant");
  assert.ok(child, "fixture setup: the descendant child renders");

  await React.act(async () => {
    child.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(
    collapsedCalls,
    0,
    "a descendant's own clip-path transitionend (event.target !== event.currentTarget) must not report the shell's collapse"
  );
});
