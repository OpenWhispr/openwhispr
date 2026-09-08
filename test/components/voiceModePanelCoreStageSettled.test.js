// Covers the new onStageSettled signal in VoiceModePanelCore.tsx (Task 10):
// the shell reports its OWN clip-path transitionend so the Live Transcript
// entrance can chain on it instead of a bare timer — but ONLY while
// mode === "live-transcript" AND open, only for the clip-path property
// specifically (not the sibling height/opacity/transform properties sharing
// this element's transition list), only for the two gated stages
// ("encapsulated" and "footer" — "content" is the last stage and gates
// nothing), and only when the event actually originated on the shell itself
// (event.target === event.currentTarget), not a bubbled descendant. It must
// also not collide with Task 7's onCollapsed, which reads the same property
// on the same element for the assistant's close.
//
// Exercised against the REAL component through react-dom's createRoot,
// dispatching a synthetic transitionend through the fake DOM's real
// addEventListener/dispatchEvent contract (installInteractiveDom) so this
// proves the actual capture-phase listener wiring, not a re-implementation of
// its logic. Same shared-Vite-server shape as
// voiceModePanelCoreCollapse.test.js, and the same reason: this component's
// render output depends only on its own props.
//
// `onPreferredHeightChange: undefined` on every live-transcript mount is
// deliberate. ExpandingPanelShell only runs its height-measurement effect
// when it has BOTH `open` and a height callback, and that effect needs
// ResizeObserver, MutationObserver and real box metrics that this fake DOM
// does not provide. It is entirely orthogonal to the capture-phase
// transitionend routing under test, so it is left switched off at the prop
// rather than papered over with fake element geometry that would prove
// nothing.
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
    cachePrefix: "openwhispr-voice-mode-panel-core-stage-settled-test-",
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

// Records every (stage) the shell reports, so a test can assert not only how
// many times it fired but WHICH stage it named — a handler that always
// reported "encapsulated" would otherwise pass a bare call count.
function recordStages() {
  const stages = [];
  return { stages, onStageSettled: (stage) => stages.push(stage) };
}

for (const stage of ["encapsulated", "footer"]) {
  test(`onStageSettled reports the "${stage}" stage on the shell's own clip-path transitionend`, async (t) => {
    const { stages, onStageSettled } = recordStages();
    const shell = await mountCore(t, {
      mode: "live-transcript",
      open: true,
      stage,
      onStageSettled,
      onPreferredHeightChange: undefined,
    });

    await React.act(async () => {
      shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
    });
    assert.deepEqual(
      stages,
      [stage],
      "the entrance gate must be told which stage finished, not merely that something did"
    );
  });
}

// "content" is the entrance's LAST stage; nothing waits behind it, and the
// hook registers no gate for it. Reporting it would resolve nothing but would
// let a future gate silently attach to the wrong beat.
test('onStageSettled never fires for the terminal "content" stage', async (t) => {
  const { stages, onStageSettled } = recordStages();
  const shell = await mountCore(t, {
    mode: "live-transcript",
    open: true,
    stage: "content",
    onStageSettled,
    onPreferredHeightChange: undefined,
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.deepEqual(stages, [], "only the two gated stages may report");
});

// The live-transcript shell's own transition list is
// `height, clip-path, opacity, transform` (dictation-panel.css). Three of
// those four finish at instants that have nothing to do with the stage
// geometry, and height in particular finishes at 180ms regardless of stage.
test("onStageSettled ignores the sibling height/opacity/transform properties on the same transition list", async (t) => {
  const { stages, onStageSettled } = recordStages();
  const shell = await mountCore(t, {
    mode: "live-transcript",
    open: true,
    stage: "encapsulated",
    onStageSettled,
    onPreferredHeightChange: undefined,
  });

  for (const propertyName of ["height", "opacity", "transform"]) {
    await React.act(async () => {
      shell.dispatchEvent(fakeTransitionEnd({ propertyName }));
    });
  }
  assert.deepEqual(stages, [], "only clip-path carries the stage geometry");
});

// The pre-open frame: mounted, entrancePhase "encapsulate", not yet open (the
// fresh-mount snap-gate's own frame, Task 4). No stage transition is running
// there — the shell is snapped, not animated — so anything arriving must not
// resolve a gate the hook has not even armed yet.
test("onStageSettled never fires while the panel is not open", async (t) => {
  const { stages, onStageSettled } = recordStages();
  const shell = await mountCore(t, {
    mode: "live-transcript",
    open: false,
    stage: "encapsulated",
    entrancePhase: "encapsulate",
    freshMount: true,
    onStageSettled,
    onPreferredHeightChange: undefined,
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.deepEqual(stages, [], "the entrance gate is armed only once the panel is genuinely open");
});

// `stage: "encapsulated"` deliberately, even though App.jsx pins the
// assistant to "content": with "content" the terminal-stage guard blocks this
// on its own and the MODE guard goes untested — proven during this task's
// bite-check, where relaxing `mode === "live-transcript"` to `mode !== null`
// left the "content" version of this test green.
test("onStageSettled never fires for assistant mode, which shares this surface", async (t) => {
  const { stages, onStageSettled } = recordStages();
  const shell = await mountCore(t, {
    mode: "assistant",
    open: true,
    stage: "encapsulated",
    onStageSettled,
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.deepEqual(stages, [], "the Agent panel has no staged entrance to gate");
});

// Task 7's onCollapsed reads the SAME property on the SAME element. The two
// signals are distinguished by mode and by open/closing, and neither may
// swallow or shadow the other.
test("onStageSettled and Task 7's onCollapsed never fire for each other's case", async (t) => {
  const { stages, onStageSettled } = recordStages();
  let collapsedCalls = 0;
  const shell = await mountCore(t, {
    mode: "assistant",
    open: false,
    closing: true,
    onStageSettled,
    onCollapsed: () => {
      collapsedCalls += 1;
    },
  });

  await React.act(async () => {
    shell.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.equal(collapsedCalls, 1, "the assistant close must still report its own collapse");
  assert.deepEqual(stages, [], "and must not also be read as a live-transcript stage settling");
});

test("onStageSettled ignores a clip-path transitionend that bubbled up from a descendant", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const { stages, onStageSettled } = recordStages();

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        VoiceModePanelCore,
        {
          mode: "live-transcript",
          open: true,
          stage: "encapsulated",
          onStageSettled,
          onPreferredHeightChange: undefined,
        },
        React.createElement("div", { className: "fake-descendant" })
      )
    );
  });
  const child = findElement(
    container,
    (el) => (el.getAttribute("class") || "") === "fake-descendant"
  );
  assert.ok(child, "fixture setup: the descendant child renders");

  await React.act(async () => {
    child.dispatchEvent(fakeTransitionEnd({ propertyName: "clip-path" }));
  });
  assert.deepEqual(
    stages,
    [],
    "a descendant's own clip-path transitionend (event.target !== event.currentTarget) must not settle the shell's stage"
  );
});
