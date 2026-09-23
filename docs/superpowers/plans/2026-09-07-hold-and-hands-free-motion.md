# Hold and Hands-free — Motion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retime the pill and panel transitions of the dictation window as one PR stacked on #1978 — one commit per transition, each verified frame by frame against the design page — and hold the agent mark through an auto-hide exit (decision 8).

**Architecture:** Plan 2 of 2 (the gesture model is `2026-09-07-hold-and-hands-free-gesture-model.md`, which must be complete on `feature/hotkey-activation-modes` first). A new branch `feature/hold-motion` is based on that branch. Springs become CSS `linear()` easings generated once in JS and installed as CSS custom properties on the dictation window root; every chained step waits on `transitionend` with a timeout fallback instead of a bare timer; the native window never resizes while a transition is visible (grow before, shrink after `transitionend`). Only `transform`, `opacity` and `clip-path` animate in new rules; every colour, size, radius, shadow, state and animation stays. `prefers-reduced-motion` collapses everything to 1 ms, as today.

**Tech Stack:** React 19 renderer (`src/App.jsx`, `src/components/dictation/*`, `src/hooks/*`, `src/styles/dictation-panel.css`), Electron main (`src/helpers/windowManager.js`, `preload.js`), react-markdown 10 (rehype plugin for the per-word rise), tests with `node --test` + tsx, the renderer test harness (`test/lib/rendererTestHarness.js`), the `ow-ui-capture` skill for frame-level verification on an `openwhispr-dev-build` rig.

**Spec:** `docs/superpowers/specs/2026-09-07-hold-and-hands-free-design.md` — section 3 (the motion table, the principles, decision 8) and section 4 (frame-level verification). Design page with the "Proposed" prototype (the app's own DOM + CSS, retimed) and the ground-truth filmstrips: https://claude.ai/code/artifact/312f3f40-4264-4bc4-92c5-5e62bae20df4 (v2.2). The prototype's override CSS and its `spring()` function are the reference for every number below.

## Global Constraints

- **Branch:** `git -C ~/dev/openwhispr-desktop worktree add <path> -b feature/hold-motion feature/hotkey-activation-modes` once Plan 1 is pushed. Never switch the shared clone. Never merge (Josh gives the go per PR). The PR's base is `feature/hotkey-activation-modes`.
- **One commit per transition**, in the order of the tasks below, so each can be reviewed against its filmstrip row. Fixes found in verification go into the transition's own commit via `git commit --fixup` + an autosquash rebase before pushing, so the PR keeps one commit per transition.
- **Animate only `transform`, `opacity`, `clip-path`** in new rules (the existing width/height transition of the listening pill stays, re-eased — see Task 2 for why).
- **Springs, from the design page:** morph `k 300 c 26`, show `k 380 c 28`, zoop `k 520 c 46`, word `k 420 c 32`, each sampled into a CSS `linear()` easing with 48 segments. **Durations, pinned:** morph 440 ms, show 260 ms, zoop 200 ms, word rise 320 ms with 28 ms stagger, copy-tick crossfade 320 ms, companion fade 160 ms, actions retreat + content fade 120 ms, listening expansion 360 ms. The easing is sampled over the spring's natural settle time and played over the pinned duration, exactly as the prototype does.
- **Chain on `transitionend` with a timeout fallback, never on a bare timer.** Fallback = the pinned duration + 120 ms.
- **The native window never changes size while a transition is visible:** grow before the transition starts (already the case for the panel), shrink on `transitionend`.
- **Reduced motion:** every new transition/animation gets a `1ms` override inside the existing `@media (prefers-reduced-motion: reduce)` block at the end of `src/styles/dictation-panel.css`.
- **Nothing removed:** no state, keyframe, colour, size, radius or shadow is deleted. A superseded rule may become unused; it is not deleted in this PR.
- **Verification per transition** (spec §4): capture the transition with the `ow-ui-capture` skill on the dev-build rig (CDP screencast + in-page rAF probe, hotkeys rebound to F13–F16 — tell Josh before holding his real hotkey; synthetic F13 holds do not reach the native listener, so hold-specific timing needs a real key press), and grade it against the design page's filmstrip row for that transition. **Pass:** the anatomy matches the "Proposed" row, the probe reports no frame over 34 ms on the M-series rig, and the window bounds (poll `BrowserWindow.getBounds()` over the rig's CDP/IPC hook, or read the `window-resized` log lines) are constant while the transition is visible.
- **Every task ends green:** `npm test` (one known environmental failure on this machine: `settingsStore imports without a bare localStorage global`, Node 25 only), `npm run typecheck`, `npm run lint`.
- **Commit style:** `feat(motion): <transition>` one per transition; `test(motion)` / `fix(motion)` as needed.
- Explain code concepts briefly for a non-technical reader in commit bodies and the PR.

---

## File Structure

| File | Responsibility after this plan |
|---|---|
| `src/utils/springEasing.ts` (new) | `springLinearEasing(k, c)` → CSS `linear()` string; `MOTION_EASING`, `MOTION_TIMING`, `motionCssVariables()` |
| `src/utils/transitionSettled.ts` (new) | `waitForTransitionEnd(el, propertyName, fallbackMs)` |
| `src/App.jsx` | Installs the motion CSS variables on `.dictation-window`; provides the pill's shrink promise to the size owner; assistant close wrapper for decision 8; zoop hide path; pill travel ease for the assistant |
| `src/components/dictation/VoicePill.tsx` | Listening expansion re-eased with the morph spring; waveform slides in by transform |
| `src/helpers/voicePillPresentation.js` | `LISTENING_ENTRANCE_TIMING.expansionMs` 360; `resolveAgentModeActive` gains `assistantPanelClosing` and `heldThroughHide` |
| `src/hooks/useMainWindowSizeOwner.js` | Shrinks on a caller-provided settle promise instead of a 340 ms timer |
| `src/styles/dictation-panel.css` | Closed shell = the pill's circle; spring transitions; zoop/unzoop; word rise; transcript tail; companion fade; reduced-motion overrides |
| `src/components/dictation/VoiceModePanelCore.tsx` | Reports the shell's own `clip-path` transitionend (`onCollapsed`, `onStageSettled`) |
| `src/hooks/useAssistantPanel.js` | Unmounts on the shell's collapse event; 120 ms content fade; actions retreat at close intent |
| `src/components/dictation/AssistantPanel.tsx` | Settled/tail markdown split with the per-word rise; copy tick pop + label crossfade; closing retreat duration |
| `src/components/ui/MarkdownRenderer.tsx` | Accepts `rehypePlugins` |
| `src/utils/streamingMarkdown.ts` (new) | `splitStreamingMarkdown(content)` |
| `src/components/dictation/rehypeWordRise.ts` (new) | Rehype plugin wrapping words in `span.assistant-word` |
| `src/hooks/useCrossfadedLabel.ts` (new) | Copied-label revert crossfade |
| `src/hooks/usePillExitChoreography.js` (new) | Zoop-then-hide, unzoop on show |
| `src/helpers/windowManager.js` | `hideDictationPanel({ animate })` defers the native hide behind the zoop; `showDictationPanel` cancels it; companion pill hide defers behind its fade |
| `preload.js`, `src/types/electron.ts` | `onPillWillHide`, `onPillWillShow`, `onAgentDictationPillWillHide`, `onAgentDictationPillWillShow` |
| `src/components/dictation/AgentDictationPillOverlay.tsx` | Fades 160 ms on close intent |
| `src/components/dictation/LiveTranscriptPanel.tsx`, `src/utils/liveTranscriptPresentation.ts` | Opacity-only tail with per-word settle |
| `src/hooks/useLiveTranscriptPanel.js` | Entrance chain gated on shell transitionend with the existing timers as fallbacks |
| Tests | `test/utils/springEasing.test.js`, `test/utils/transitionSettled.test.js`, `test/hooks/useMainWindowSizeOwner.test.js`, `test/utils/streamingMarkdown.test.js`, `test/components/rehypeWordRise.test.js`, `test/hooks/useCrossfadedLabel.test.js`, `test/helpers/windowManagerPillHide.test.js`, `test/hooks/usePillExitChoreography.test.js`, additions to `test/helpers/voicePillPresentation.test.js` and `test/utils/liveTranscriptPresentation.test.js` |

---

### Task 1: Motion utilities — spring easings, timing constants, `transitionend` gate

**Files:**
- Create: `src/utils/springEasing.ts`, `src/utils/transitionSettled.ts`
- Modify: `src/App.jsx` (root `<div className="dictation-window">` gets the CSS variables), `src/components/dictation/AgentDictationPillOverlay.tsx` (same on `<main className="agent-dictation-pill-window dictation-window">`)
- Test: `test/utils/springEasing.test.js`, `test/utils/transitionSettled.test.js`

**Interfaces:**
- Produces:
  - `springLinearEasing(stiffness: number, damping: number, mass?: number, segments?: number): string` — `"linear(0.0000 0.0%, …, 1.0000 100.0%)"`, 49 points.
  - `MOTION_EASING: { morph, show, zoop, word }` (strings) and `MOTION_TIMING: { morphMs: 440, showMs: 260, zoopMs: 200, wordMs: 320, wordStaggerMs: 28, copyCrossfadeMs: 320, companionFadeMs: 160, closeFadeMs: 120, listeningExpansionMs: 360 }` (frozen).
  - `motionCssVariables(): Record<string, string>` → `--motion-morph-ease`, `--motion-morph-ms`, `--motion-show-ease`, `--motion-show-ms`, `--motion-zoop-ease`, `--motion-zoop-ms`, `--motion-word-ease`, `--motion-word-ms`, `--motion-word-stagger-ms`, `--motion-companion-fade-ms`, `--motion-close-fade-ms`.
  - `waitForTransitionEnd(el: EventTarget | null, propertyName: string, fallbackMs: number): Promise<"transitionend" | "timeout">` — resolves on the first `transitionend` whose `target === el` and `propertyName` matches; otherwise on the fallback timer; always removes its listener.

Plain-English: a "spring" is a curve that eases into place with a small overshoot, like a real object settling. Browsers accept such a curve as a list of sample points (`linear(...)`). We compute the list once in JavaScript and hand it to CSS as a named variable, so every transition can say "use the morph spring" without a library.

- [ ] **Step 1: Write the failing tests**

`test/utils/springEasing.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/springEasing.ts");

test("a spring samples into a linear() easing that starts at 0 and ends at 1", async () => {
  const { springLinearEasing } = await load();
  const easing = springLinearEasing(300, 26);
  assert.match(easing, /^linear\(/);
  const points = easing.slice("linear(".length, -1).split(", ");
  assert.equal(points.length, 49);
  assert.equal(points[0], "0.0000 0.0%");
  assert.equal(points.at(-1), "1.0000 100.0%");
  // The morph overshoots a little (under-damped) and settles.
  const values = points.map((p) => Number(p.split(" ")[0]));
  assert.ok(Math.max(...values) > 1.0);
  assert.ok(Math.max(...values) < 1.08);
});

test("an over-damped spring never overshoots", async () => {
  const { springLinearEasing } = await load();
  const values = springLinearEasing(520, 46)
    .slice("linear(".length, -1)
    .split(", ")
    .map((p) => Number(p.split(" ")[0]));
  assert.ok(values.every((v) => v <= 1.0));
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1] - 1e-9);
});

test("the pinned timings and CSS variables match the design page", async () => {
  const { MOTION_TIMING, MOTION_EASING, motionCssVariables } = await load();
  assert.deepEqual(MOTION_TIMING, {
    morphMs: 440,
    showMs: 260,
    zoopMs: 200,
    wordMs: 320,
    wordStaggerMs: 28,
    copyCrossfadeMs: 320,
    companionFadeMs: 160,
    closeFadeMs: 120,
    listeningExpansionMs: 360,
  });
  const vars = motionCssVariables();
  assert.equal(vars["--motion-morph-ease"], MOTION_EASING.morph);
  assert.equal(vars["--motion-morph-ms"], "440ms");
  assert.equal(vars["--motion-zoop-ms"], "200ms");
  assert.equal(vars["--motion-word-stagger-ms"], "28ms");
});
```

`test/utils/transitionSettled.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transitionSettled.ts");

function fakeElement() {
  const listeners = new Set();
  return {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    fire(target, propertyName) {
      for (const fn of [...listeners]) fn({ target, propertyName });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

test("resolves on the element's own transitionend for the property and unsubscribes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "clip-path", 500);
  el.fire({ other: true }, "clip-path"); // a child's event: ignored
  el.fire(el, "opacity"); // another property: ignored
  el.fire(el, "clip-path");
  assert.equal(await settled, "transitionend");
  assert.equal(el.listenerCount, 0);
});

test("falls back to the timeout when no event arrives, and on a missing element", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { waitForTransitionEnd } = await load();
  const el = fakeElement();
  const settled = waitForTransitionEnd(el, "transform", 300);
  t.mock.timers.tick(300);
  assert.equal(await settled, "timeout");
  assert.equal(el.listenerCount, 0);

  const missing = waitForTransitionEnd(null, "transform", 10);
  t.mock.timers.tick(10);
  assert.equal(await missing, "timeout");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/utils/springEasing.test.js test/utils/transitionSettled.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/utils/springEasing.ts`:

```ts
// Springs as CSS linear() easings, generated once (no animation library).
// The curve is the closed-form damped spring from the design page's
// prototype, sampled over its natural settle time and played over the
// pinned duration below — the same trick the prototype uses for "show".

export function springLinearEasing(
  stiffness: number,
  damping: number,
  mass = 1,
  segments = 48
): string {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let settleSeconds: number;
  let position: (t: number) => number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    settleSeconds = -Math.log(0.001) / (zeta * w0);
    position = (t) =>
      1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  } else {
    settleSeconds = (-Math.log(0.001) / w0) * 1.6;
    position = (t) => 1 - (1 + w0 * t) * Math.exp(-w0 * t);
  }
  const points: string[] = [];
  for (let i = 0; i <= segments; i++) {
    const progress = i / segments;
    const value = i === segments ? 1 : position(progress * settleSeconds);
    points.push(`${value.toFixed(4)} ${(progress * 100).toFixed(1)}%`);
  }
  return `linear(${points.join(", ")})`;
}

export const MOTION_EASING = Object.freeze({
  morph: springLinearEasing(300, 26),
  show: springLinearEasing(380, 28),
  zoop: springLinearEasing(520, 46),
  word: springLinearEasing(420, 32),
});

export const MOTION_TIMING = Object.freeze({
  morphMs: 440,
  showMs: 260,
  zoopMs: 200,
  wordMs: 320,
  wordStaggerMs: 28,
  copyCrossfadeMs: 320,
  companionFadeMs: 160,
  closeFadeMs: 120,
  listeningExpansionMs: 360,
});

export function motionCssVariables(): Record<string, string> {
  return {
    "--motion-morph-ease": MOTION_EASING.morph,
    "--motion-morph-ms": `${MOTION_TIMING.morphMs}ms`,
    "--motion-show-ease": MOTION_EASING.show,
    "--motion-show-ms": `${MOTION_TIMING.showMs}ms`,
    "--motion-zoop-ease": MOTION_EASING.zoop,
    "--motion-zoop-ms": `${MOTION_TIMING.zoopMs}ms`,
    "--motion-word-ease": MOTION_EASING.word,
    "--motion-word-ms": `${MOTION_TIMING.wordMs}ms`,
    "--motion-word-stagger-ms": `${MOTION_TIMING.wordStaggerMs}ms`,
    "--motion-companion-fade-ms": `${MOTION_TIMING.companionFadeMs}ms`,
    "--motion-close-fade-ms": `${MOTION_TIMING.closeFadeMs}ms`,
  };
}
```

`src/utils/transitionSettled.ts`:

```ts
// Chain choreography on the browser's own "this transition finished" event,
// with a timeout only as a safety net (reduced motion, a torn-down node, a
// property that never changed). Always unsubscribes.
export function waitForTransitionEnd(
  el: EventTarget | null,
  propertyName: string,
  fallbackMs: number
): Promise<"transitionend" | "timeout"> {
  return new Promise((resolve) => {
    if (!el) {
      setTimeout(() => resolve("timeout"), fallbackMs);
      return;
    }
    let done = false;
    const finish = (how: "transitionend" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
      resolve(how);
    };
    const onEnd = (event: Event) => {
      const transition = event as TransitionEvent;
      if (transition.target !== el || transition.propertyName !== propertyName) return;
      finish("transitionend");
    };
    const timer = setTimeout(() => finish("timeout"), fallbackMs);
    el.addEventListener("transitionend", onEnd);
  });
}
```

In `src/App.jsx`, import `motionCssVariables` and give the root div the variables once:

```jsx
    <div className="dictation-window" style={motionCssVariables()}>
```

(`motionCssVariables()` builds a small object each render; wrap in `useMemo(() => motionCssVariables(), [])` at the top of `App`.) Do the same on the companion overlay's `<main className="agent-dictation-pill-window dictation-window">`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/utils/springEasing.test.js test/utils/transitionSettled.test.js && npm run typecheck`
Expected: pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/utils/springEasing.ts src/utils/transitionSettled.ts src/App.jsx src/components/dictation/AgentDictationPillOverlay.tsx test/utils/springEasing.test.js test/utils/transitionSettled.test.js
git commit -m "feat(motion): spring easings as CSS linear() variables and a transitionend gate

No visible change yet. Springs are sampled once in JS and installed as
CSS variables on the dictation window; chained steps will wait on the
browser's transitionend with a timeout only as a safety net."
```

---

### Task 2: Listening entrance — spring-eased widening, waveform slides in

**Files:**
- Modify: `src/helpers/voicePillPresentation.js` (`LISTENING_ENTRANCE_TIMING.expansionMs`)
- Modify: `src/components/dictation/VoicePill.tsx` (`GROW_TRANSITION`, the waveform reveal)
- Test: `test/helpers/voicePillPresentation.test.js` (the `listening entrance timers preserve the visual order` test at line 320)

**Interfaces:**
- Consumes: `--motion-morph-ease`, `--motion-show-ease` (Task 1), `MOTION_TIMING.listeningExpansionMs`.
- Produces: `LISTENING_ENTRANCE_TIMING.expansionMs === 360`.

**A decision to flag for Josh at review.** The spec table says "widen by clip-path on a fixed 92×40 box". The approved prototype on the design page did not do that: its "Proposed" mode re-eases the existing `width/height/padding` transition with the spring over 360 ms (`.voice-pill-control { transition: width var(--l-dur, 360ms) var(--p-ease) … }`). A clip-path reveal of a bordered capsule cuts the border at the leading edge for the whole motion (the clip edge is a cut through the element, so no 1 px border is drawn there), which is visible against both themes. This task therefore implements what the prototype rendered and Josh approved — the spring-eased layout transition, which the capture harness already measured as clean (one long frame) — and keeps the pill's window contract (`VOICE_PILL_FOOTPRINT` ↔ `WINDOW_SIZES.RECORDING`) untouched. If Josh wants the literal clip-path version, the border problem needs a design answer first.

- [ ] **Step 1: Write the failing test**

In `test/helpers/voicePillPresentation.test.js`, extend the test at line 320 (`listening entrance timers preserve the visual order`) with the pinned numbers:

```js
  const { LISTENING_ENTRANCE_TIMING } = await load();
  assert.equal(LISTENING_ENTRANCE_TIMING.thinkingMs, 420);
  assert.equal(LISTENING_ENTRANCE_TIMING.expansionMs, 360);
  assert.equal(timeline.expandAtMs, 420);
  assert.equal(timeline.settleAtMs, 780);
  assert.equal(timeline.waveformAtMs, 880);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/helpers/voicePillPresentation.test.js`
Expected: FAIL `300 !== 360`.

- [ ] **Step 3: Implement**

In `src/helpers/voicePillPresentation.js`, `LISTENING_ENTRANCE_TIMING.expansionMs: 360` with the comment "the morph spring, played over 360 ms".

In `src/components/dictation/VoicePill.tsx`:

```ts
const GROW_TRANSITION = `${LISTENING_ENTRANCE_TIMING.expansionMs}ms var(--motion-morph-ease, cubic-bezier(0.2, 0, 0, 1))`;
```

and make the live waveform slide in from the right as it reveals — on the `PillWaveform` element replace the class-only opacity toggle with a transform + opacity pair:

```tsx
        <PillWaveform
          getLevel={getAudioLevel}
          active={isRecording}
          className="absolute inset-0"
          style={{
            opacity: showCompactPill && waveformVisible && isRecording ? 1 : 0,
            transform:
              showCompactPill && waveformVisible && isRecording
                ? "translateX(0)"
                : `translateX(${horizontalDirection === "left" ? "-6px" : "6px"})`,
            transition:
              "opacity 200ms ease-out, transform 200ms var(--motion-show-ease, cubic-bezier(0.2, 0, 0, 1))",
          }}
        />
```

(`PillWaveform` must forward `style` to its root; check `src/components/dictation/PillWaveform.tsx` and add `style?: CSSProperties` to its props if it does not.)

- [ ] **Step 4: Run the tests, then capture**

Run: `npm test -- test/helpers/voicePillPresentation.test.js test/components/liveWaveform.test.js && npm run typecheck`
Expected: pass.

Capture: on the rig, start a recording by clicking the pill (the click path shares every pill state with the hotkey path). Grade against the design page row **Listening entrance** ("same hold; widen … spring ~360ms; waveform slides in on the right"). Window: `RECORDING` (208×120) must be applied before the widening starts (it is — `windowFitsCompactPill` grows during the static thinking hold) and must not change during it.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/voicePillPresentation.js src/components/dictation/VoicePill.tsx src/components/dictation/PillWaveform.tsx test/helpers/voicePillPresentation.test.js
git commit -m "feat(motion): listening entrance widens on the morph spring; the waveform slides in

Same 420ms thinking hold. The capsule now eases open with the spring over
360ms instead of a 300ms curve, and the live waveform slides in from the
outer edge as it fades up, so the reveal reads as one motion."
```

---

### Task 3: Stop → idle — the window shrinks on `transitionend`, not a timer

**Files:**
- Modify: `src/hooks/useMainWindowSizeOwner.js` (the `setTimeout(…, 340)` branch, lines ~106–108, and the parameter list)
- Modify: `src/App.jsx` (pass `waitForShrink`)
- Test (new): `test/hooks/useMainWindowSizeOwner.test.js`

**Interfaces:**
- Consumes: `waitForTransitionEnd` (Task 1); `buttonRef` in `App.jsx` (already the `.voice-pill-control` element, passed to `VoicePill ref`).
- Produces: `useMainWindowSizeOwner({ …, waitForShrink?: () => Promise<unknown> })` — when given, a lower-ranked target is applied after the promise settles; when absent, after 340 ms as today.

- [ ] **Step 1: Write the failing test**

`test/hooks/useMainWindowSizeOwner.test.js`:

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

async function mountOwner(t, { waitForShrink }) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-main-window-size-owner-test-",
  });
  const { useMainWindowSizeOwner } = await vite.ssrLoadModule("/hooks/useMainWindowSizeOwner.js");

  const requests = [];
  const refs = { assistantOpenRef: { current: false }, liveTranscriptOpenRef: { current: false } };
  let props = {
    requestMainWindowSize: async (key) => {
      requests.push(key);
      return { success: true };
    },
    dictationErrorActionCount: 0,
    toastCount: 0,
    isCommandMenuOpen: false,
    isCompactPill: false,
    handsFreeTipVisible: false,
    assistantOpen: false,
    assistantMounted: false,
    liveTranscriptOpen: false,
    liveTranscriptMounted: false,
    ...refs,
    waitForShrink,
  };
  function Harness() {
    useMainWindowSizeOwner(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  };
  await render();
  return { render, requests };
}

test("a grow applies at once; a shrink waits for the caller's settle promise", async (t) => {
  let settle;
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => new Promise((resolve) => (settle = resolve)),
  });
  assert.deepEqual(requests, ["BASE"]);

  await render({ isCompactPill: true });
  assert.deepEqual(requests, ["BASE", "RECORDING"]);

  await render({ isCompactPill: false });
  assert.deepEqual(requests, ["BASE", "RECORDING"], "shrink must not be requested yet");

  await React.act(async () => {
    settle();
  });
  assert.deepEqual(requests, ["BASE", "RECORDING", "BASE"]);
});

test("a grow that supersedes a pending shrink cancels it", async (t) => {
  let settle;
  const { render, requests } = await mountOwner(t, {
    waitForShrink: () => new Promise((resolve) => (settle = resolve)),
  });
  await render({ isCompactPill: true });
  await render({ isCompactPill: false });
  await render({ isCommandMenuOpen: true });
  assert.deepEqual(requests, ["BASE", "RECORDING", "WITH_MENU"]);
  await React.act(async () => {
    settle();
  });
  assert.deepEqual(requests, ["BASE", "RECORDING", "WITH_MENU"], "the stale shrink never lands");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/hooks/useMainWindowSizeOwner.test.js`
Expected: the first test fails at "shrink must not be requested yet" only after 340 ms… it will actually fail because the shrink is requested by the timer after 340 ms while `settle` was never called — assert on the third render: with the timer version `requests` still equals `["BASE","RECORDING"]` immediately, then the final assertion after `settle()` fails because the promise is ignored (`BASE` arrives only via the timer). Either way the file does not pass.

- [ ] **Step 3: Implement**

In `src/hooks/useMainWindowSizeOwner.js`, add `waitForShrink` to the destructured params and replace the timer branch:

```js
    // A lower-ranked target means content is collapsing: let the collapse
    // finish (the caller reports its transitionend) before the native window
    // snaps down, so the two never animate the same edge at once.
    let cancelled = false;
    const settled = waitForShrink
      ? waitForShrink()
      : new Promise((resolve) => setTimeout(resolve, 340));
    void settled.then(() => {
      if (!cancelled) void requestMainWindowSize(target);
    });
    return () => {
      cancelled = true;
    };
```

Add `waitForShrink` to the effect's dependency array.

In `src/App.jsx`, pass it from the pill control ref (the pill's width transition ends when the capsule has narrowed; anything else that shrinks — a menu, a toast — has no pill transition and takes the 340 ms fallback as today):

```js
  const waitForPillShrink = React.useCallback(
    () => waitForTransitionEnd(buttonRef.current, "width", 340),
    []
  );
  …
  const { dictationErrorPillHandoffActive } = useMainWindowSizeOwner({
    …,
    waitForShrink: waitForPillShrink,
  });
```

- [ ] **Step 4: Run the tests, then capture**

Run: `npm test -- test/hooks/useMainWindowSizeOwner.test.js test/hooks/useHandsFreeTip.test.js && npm run typecheck`
Expected: pass.

Capture: stop a recording (click the pill while recording) and cancel one (the X). Grade against **Stop → idle** ("same narrow; window shrink on transitionend"): the window goes `RECORDING → BASE` only after the capsule has finished narrowing; no frame shows the window edge moving while the pill is still shrinking.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMainWindowSizeOwner.js src/App.jsx test/hooks/useMainWindowSizeOwner.test.js
git commit -m "feat(motion): shrink the pill window when the capsule has finished narrowing

The size owner used a 340ms timer to guess when the pill had collapsed.
It now waits for the pill's own width transition to end (timer only as
a fallback), so the native window never moves while the pill still is."
```

---

### Task 4: Panel open — the shell springs open from the pill's circle

**Files:**
- Modify: `src/styles/dictation-panel.css` (the `.expanding-panel-surface` closed state, lines 7–31; new live-transcript-scoped rules; `.voice-pill-position` transition, line ~397)
- Modify: `src/App.jsx` (`voicePillTravelDuration` and a new `--voice-pill-travel-ease` for the assistant)
- Modify: `src/components/dictation/VoiceModePanelCore.tsx` (nothing functional; verify `data-panel-mode` is absent at rest — it is: `data-panel-mode={mode ?? undefined}`)

**Interfaces:**
- Consumes: `--motion-morph-ease`, `--motion-morph-ms`.
- Produces: the resting/assistant closed clip = the pill's circle; CSS var `--voice-pill-travel-ease` read by `.voice-pill-position`.

Geometry: the shell is `inset-x-3 bottom-3` (12 px from the window's edges) and the pill's floating dock is 12 px from the same edges with a 40 px circle, so the pill's circle is exactly the shell's bottom-right (or bottom-left) 40×40 corner: `inset(calc(100% - 40px) 0 0 calc(100% - 40px) round 20px)`. `clip-path` clips the shell's drop shadow too, so the closed circle carries no halo. The shell is `visibility: hidden` whenever no mode is mounted, so nothing sits under the pill at rest.

- [ ] **Step 1: Write the CSS**

Replace lines 7–31 of `src/styles/dictation-panel.css` with:

```css
/* Shared pill-to-panel surface. Closed, the surface IS the pill's circle at
   the resting dock (the shell is inset 12px like the pill, so the circle is
   its bottom corner). Opening springs the circle open on the morph spring;
   closing springs it shut. clip-path clips the shadow as well, so the closed
   circle carries no halo. Nothing is mounted at rest, so it is hidden then. */
.expanding-panel-surface {
  clip-path: inset(calc(100% - 40px) 0 0 calc(100% - 40px) round 20px);
  opacity: 1;
  pointer-events: none;
  transform: none;
  transition:
    clip-path var(--motion-morph-ms, 440ms) var(--motion-morph-ease, cubic-bezier(0.2, 0, 0, 1)),
    opacity 180ms linear,
    transform var(--motion-morph-ms, 440ms) var(--motion-morph-ease, cubic-bezier(0.2, 0, 0, 1));
  will-change: clip-path, opacity, transform;
}

.expanding-panel-surface:not([data-panel-mode]) {
  visibility: hidden;
}

.expanding-panel-anchor-bottom-right {
  transform-origin: bottom right;
}

.expanding-panel-anchor-bottom-left {
  clip-path: inset(calc(100% - 40px) calc(100% - 40px) 0 0 round 20px);
  transform-origin: bottom left;
}

.expanding-panel-surface-open {
  clip-path: inset(0 round 24px);
  opacity: 1;
  pointer-events: auto;
  transform: none;
}

/* Live Transcript keeps its established corner-box origin and fade: its
   entrance is staged from the encapsulated footer and is out of scope here. */
.expanding-panel-surface[data-panel-mode="live-transcript"]:not(.expanding-panel-surface-open) {
  clip-path: inset(calc(100% - 52px) 0 0 calc(100% - 108px) round 24px);
  opacity: 0;
  transform: translate(4px, 4px);
}

.expanding-panel-surface[data-panel-mode="live-transcript"].expanding-panel-anchor-bottom-left:not(.expanding-panel-surface-open) {
  clip-path: inset(calc(100% - 52px) calc(100% - 108px) 0 0 round 24px);
  transform: translate(-4px, 4px);
}
```

The live-transcript mode's own `transition:` block (line ~59) already overrides the shared one, so its durations are unchanged.

Update `.voice-pill-position` (line ~397) to accept an ease variable:

```css
.voice-pill-position {
  transition:
    left var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1)),
    bottom var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1)),
    transform var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1));
  will-change: left, bottom, transform;
}
```

In the reduced-motion block at the end of the file, add:

```css
  .expanding-panel-surface,
  .voice-pill-position {
    transition-duration: 1ms !important;
  }
```

- [ ] **Step 2: Make the pill glide on the same spring**

In `src/App.jsx`, where `voicePillTravelDuration` is computed (around line 543):

```js
  const voicePillTravelDuration = assistant.mounted
    ? MOTION_TIMING.morphMs
    : liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;
  const voicePillTravelEase = assistant.mounted ? "var(--motion-morph-ease)" : undefined;
```

and on the `.voice-pill-position` div's `style`, add `"--voice-pill-travel-ease": voicePillTravelEase`.

- [ ] **Step 3: Verify**

Run: `npm test -- test/helpers/voicePillPresentation.test.js && npm run typecheck && npm run lint`
Expected: pass.

Capture: open the agent panel (F14 tap on the rig, or the command menu's "Ask"). Grade against **Panel open** ("pre-grow unchanged; shell springs from the pill's circle; pill glides to the footer during it"): the first visible shell frame is a circle under the pill, not a corner rectangle; the window is already `ASSISTANT` (466×562) before the first shell frame; the pill arrives at the footer dock as the shell finishes. Also capture a live-transcript entrance and confirm it is frame-identical to the ground-truth strip (this task must not change it).

- [ ] **Step 4: Commit**

```bash
git add src/styles/dictation-panel.css src/App.jsx
git commit -m "feat(motion): the agent panel springs open from the pill's circle

The closed surface is now the pill's own circle at the resting dock,
hidden while nothing is mounted, so opening reads as the pill growing
into the panel rather than a rectangle appearing at the corner. The
pill glides to the footer on the same spring. Live Transcript keeps its
own entrance."
```

---

### Task 5: Streaming reply — per-word rise, settled blocks never re-rendered

**Files:**
- Create: `src/utils/streamingMarkdown.ts`, `src/components/dictation/rehypeWordRise.ts`
- Modify: `src/components/ui/MarkdownRenderer.tsx` (accept `rehypePlugins`), `src/components/dictation/AssistantPanel.tsx` (lines ~280–290 and the render at ~478–500), `src/styles/dictation-panel.css`
- Test: `test/utils/streamingMarkdown.test.js`, `test/components/rehypeWordRise.test.js`

**Interfaces:**
- Consumes: `--motion-word-ease`, `--motion-word-ms`, `--motion-word-stagger-ms`.
- Produces:
  - `splitStreamingMarkdown(content: string): { settled: string; tail: string }` — `settled` is everything up to and including the last blank-line block boundary (`\n\n`), `tail` the rest; no boundary → `settled: ""`; content ending in `\n\n` → `tail: ""`.
  - `countWords(text: string): number` (whitespace-separated).
  - `rehypeWordRise({ firstNewWordIndex, staggerMs }): (tree) => void` — wraps every whitespace-separated word in text nodes (outside `code`/`pre`) in `<span class="assistant-word" data-word-index="i">`, adding `data-rise="true"` and `style="animation-delay: (i - firstNewWordIndex) * staggerMs ms"` for `i >= firstNewWordIndex`; whitespace stays as text nodes.

How it reads: while a reply streams, the text before the last paragraph break is "settled" and rendered once as normal markdown (it never re-renders, because its input string stops changing); only the current paragraph is re-rendered per token, with each newly arrived word wrapped in a span that plays a short rise once. The blinking caret is unchanged. When streaming ends the whole reply renders as one plain block.

- [ ] **Step 1: Write the failing tests**

`test/utils/streamingMarkdown.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/streamingMarkdown.ts");

test("splits at the last paragraph boundary", async () => {
  const { splitStreamingMarkdown } = await load();
  assert.deepEqual(splitStreamingMarkdown("One.\n\nTwo.\n\nThr"), {
    settled: "One.\n\nTwo.\n\n",
    tail: "Thr",
  });
  assert.deepEqual(splitStreamingMarkdown("Only one block so far"), {
    settled: "",
    tail: "Only one block so far",
  });
  assert.deepEqual(splitStreamingMarkdown("Done.\n\n"), { settled: "Done.\n\n", tail: "" });
  assert.deepEqual(splitStreamingMarkdown(""), { settled: "", tail: "" });
});

test("counts whitespace-separated words", async () => {
  const { countWords } = await load();
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  hello   big\nworld "), 3);
});
```

`test/components/rehypeWordRise.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/dictation/rehypeWordRise.ts");

const text = (value) => ({ type: "text", value });
const element = (tagName, children, properties = {}) => ({
  type: "element",
  tagName,
  properties,
  children,
});

test("wraps each word in a span, animating only words at or after the first new index", async () => {
  const { rehypeWordRise } = await load();
  const tree = { type: "root", children: [element("p", [text("hello big world")])] };
  rehypeWordRise({ firstNewWordIndex: 1, staggerMs: 28 })(tree);

  const spans = tree.children[0].children.filter((n) => n.type === "element");
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => s.properties["data-word-index"]),
    [0, 1, 2]
  );
  assert.equal(spans[0].properties["data-rise"], undefined);
  assert.equal(spans[1].properties["data-rise"], "true");
  assert.equal(spans[1].properties.style, "animation-delay: 0ms");
  assert.equal(spans[2].properties.style, "animation-delay: 28ms");
  // Whitespace survives as text between the spans.
  assert.equal(tree.children[0].children.filter((n) => n.type === "text").length, 2);
});

test("word indices run across elements in document order and skip code", async () => {
  const { rehypeWordRise } = await load();
  const tree = {
    type: "root",
    children: [
      element("p", [text("a "), element("strong", [text("b c")]), text(" d")]),
      element("pre", [element("code", [text("not words")])]),
    ],
  };
  rehypeWordRise({ firstNewWordIndex: 0, staggerMs: 28 })(tree);
  const indices = [];
  const walk = (node) => {
    if (node.type === "element" && node.tagName === "span") indices.push(node.properties["data-word-index"]);
    (node.children || []).forEach(walk);
  };
  walk(tree);
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(tree.children[1].children[0].children[0].value, "not words");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/utils/streamingMarkdown.test.js test/components/rehypeWordRise.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/utils/streamingMarkdown.ts`:

```ts
// A streaming reply is rendered as "settled" markdown (everything before the
// last paragraph break, re-rendered only when that boundary moves) plus the
// current paragraph, which is the only part touched per token.
export function splitStreamingMarkdown(content: string): { settled: string; tail: string } {
  const boundary = content.lastIndexOf("\n\n");
  if (boundary === -1) return { settled: "", tail: content };
  const end = boundary + 2;
  return { settled: content.slice(0, end), tail: content.slice(end) };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
```

`src/components/dictation/rehypeWordRise.ts`:

```ts
// Rehype plugin for the streaming tail: every word becomes a span so newly
// arrived words can rise in once. Indices run in document order across the
// whole tree, so React keeps earlier spans stable as the tail grows.
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(["code", "pre"]);

export function rehypeWordRise({
  firstNewWordIndex,
  staggerMs,
}: {
  firstNewWordIndex: number;
  staggerMs: number;
}) {
  return (tree: HastNode) => {
    let index = 0;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "element") {
          if (!SKIP.has(child.tagName ?? "")) visit(child);
          next.push(child);
          continue;
        }
        if (child.type !== "text" || !child.value) {
          next.push(child);
          continue;
        }
        for (const part of child.value.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) {
            next.push({ type: "text", value: part });
            continue;
          }
          const isNew = index >= firstNewWordIndex;
          next.push({
            type: "element",
            tagName: "span",
            properties: {
              className: ["assistant-word"],
              "data-word-index": index,
              ...(isNew
                ? {
                    "data-rise": "true",
                    style: `animation-delay: ${(index - firstNewWordIndex) * staggerMs}ms`,
                  }
                : {}),
            },
            children: [{ type: "text", value: part }],
          });
          index += 1;
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}
```

`src/components/ui/MarkdownRenderer.tsx`: add `rehypePlugins?: ComponentProps<typeof Markdown>["rehypePlugins"]` to the props and pass `rehypePlugins={rehypePlugins}` to `<Markdown>`.

`src/components/dictation/AssistantPanel.tsx`, replacing the single `StableAssistantMarkdown` render (around lines 487–490):

```tsx
  const isStreamingNow = Boolean(latestAssistantMessage?.isStreaming);
  const { settled: settledMarkdown, tail: tailMarkdown } = useMemo(
    () => (isStreamingNow ? splitStreamingMarkdown(displayedResponse) : { settled: displayedResponse, tail: "" }),
    [displayedResponse, isStreamingNow]
  );
  // Words already risen in the current tail; reset whenever the tail restarts.
  const risenWordsRef = useRef(0);
  const tailWordCount = countWords(tailMarkdown);
  if (tailWordCount < risenWordsRef.current) risenWordsRef.current = 0;
  const firstNewWordIndex = risenWordsRef.current;
  useLayoutEffect(() => {
    risenWordsRef.current = tailWordCount;
  });
  const tailPlugins = useMemo(
    () => [rehypeWordRise({ firstNewWordIndex, staggerMs: MOTION_TIMING.wordStaggerMs })],
    [firstNewWordIndex]
  );
  …
                <div className={settledMarkdown && tailMarkdown ? "space-y-2" : undefined}>
                  {settledMarkdown && (
                    <StableAssistantMarkdown content={settledMarkdown} className={RESPONSE_MARKDOWN_CLASS} />
                  )}
                  {tailMarkdown && (
                    <MarkdownRenderer
                      content={tailMarkdown}
                      className={RESPONSE_MARKDOWN_CLASS}
                      rehypePlugins={tailPlugins}
                    />
                  )}
                </div>
                {latestAssistantMessage?.isStreaming && ( …caret unchanged… )}
```

where `RESPONSE_MARKDOWN_CLASS` is the existing class string from that render (`"text-[15px] leading-relaxed text-foreground selection:bg-agent-brand/35 …"`) lifted to a constant.

CSS, in `src/styles/dictation-panel.css` (before the reduced-motion block):

```css
/* Streaming reply: each newly arrived word rises in once on the word spring.
   Settled words carry no animation; their spans stay in place as the tail grows. */
.assistant-word[data-rise="true"] {
  display: inline-block;
  animation: assistant-word-rise var(--motion-word-ms, 320ms)
    var(--motion-word-ease, cubic-bezier(0.2, 0, 0, 1)) both;
}

@keyframes assistant-word-rise {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
```

and in the reduced-motion block: `.assistant-word[data-rise="true"] { animation: none; }`.

- [ ] **Step 4: Run the tests, then capture**

Run: `npm test -- test/utils/streamingMarkdown.test.js test/components/rehypeWordRise.test.js && npm run typecheck && npm run lint`
Expected: pass.

Capture: ask the agent a question that yields three or more paragraphs. Grade against **Streaming reply** ("per-word rise 320ms with 28ms stagger; caret unchanged; settled blocks never re-rendered"): words rise once, earlier paragraphs never flicker, the caret still blinks after the last word, and the React profiler (or a `console.count` in a temporary effect) confirms the settled renderer does not re-render per token.

- [ ] **Step 5: Commit**

```bash
git add src/utils/streamingMarkdown.ts src/components/dictation/rehypeWordRise.ts src/components/ui/MarkdownRenderer.tsx src/components/dictation/AssistantPanel.tsx src/styles/dictation-panel.css test/utils/streamingMarkdown.test.js test/components/rehypeWordRise.test.js
git commit -m "feat(motion): streamed reply rises in word by word; settled paragraphs stop re-rendering

While a reply streams, finished paragraphs render once and stay put;
only the current paragraph updates per token, and each new word plays a
short rise. The caret is unchanged."
```

---

### Task 6: Copy tick — pop on arrival, 320 ms label crossfade on revert

**Files:**
- Create: `src/hooks/useCrossfadedLabel.ts`
- Modify: `src/components/dictation/AssistantPanel.tsx` (the Copy button, lines ~596–610)
- Test: `test/hooks/useCrossfadedLabel.test.js`

**Interfaces:**
- Produces: `useCrossfadedLabel(active: boolean, revertMs: number): { showActive: boolean; fading: boolean }` — turning `active` on is immediate; turning it off first sets `fading` for `revertMs`, then `showActive` becomes false and `fading` clears.

- [ ] **Step 1: Write the failing test**

`test/hooks/useCrossfadedLabel.test.js`:

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

test("the active label appears at once and fades for revertMs before reverting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-crossfaded-label-test-" });
  const { useCrossfadedLabel } = await vite.ssrLoadModule("/hooks/useCrossfadedLabel.ts");

  let active = false;
  let result;
  function Harness() {
    result = useCrossfadedLabel(active, 320);
    return null;
  }
  root = createRoot(container);
  const render = async (next) => {
    active = next;
    await React.act(async () => root.render(React.createElement(Harness)));
  };

  await render(false);
  assert.deepEqual(result, { showActive: false, fading: false });
  await render(true);
  assert.deepEqual(result, { showActive: true, fading: false });
  await render(false);
  assert.deepEqual(result, { showActive: true, fading: true });
  await React.act(async () => {
    t.mock.timers.tick(320);
  });
  assert.deepEqual(result, { showActive: false, fading: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/hooks/useCrossfadedLabel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/hooks/useCrossfadedLabel.ts`:

```ts
import { useEffect, useRef, useState } from "react";

/**
 * A label that switches on immediately and off through a fade: the caller
 * renders the "active" copy while `showActive`, at opacity 0 while `fading`,
 * so the revert reads as a crossfade instead of a hard swap.
 */
export function useCrossfadedLabel(
  active: boolean,
  revertMs: number
): { showActive: boolean; fading: boolean } {
  const [showActive, setShowActive] = useState(active);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (active) {
      setShowActive(true);
      setFading(false);
      return;
    }
    if (!showActive) return;
    setFading(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setShowActive(false);
      setFading(false);
    }, revertMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // showActive is intentionally read, not tracked: a revert must not re-arm itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revertMs]);

  return { showActive, fading };
}
```

In `AssistantPanel.tsx`, the Copy button body becomes:

```tsx
  const copiedLabel = useCrossfadedLabel(copied, MOTION_TIMING.copyCrossfadeMs);
  …
              <span
                className="inline-flex items-center gap-1.5"
                style={{
                  opacity: copiedLabel.fading ? 0 : 1,
                  transition: `opacity ${MOTION_TIMING.copyCrossfadeMs}ms ease-out`,
                }}
              >
                {copiedLabel.showActive ? (
                  <Check
                    aria-hidden="true"
                    style={{ animation: "tool-check-pop 300ms cubic-bezier(0.2, 0, 0, 1) both" }}
                  />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copiedLabel.showActive ? t("common.copied") : t("assistant.panel.copyToClipboard")}
                {!copiedLabel.showActive && (
                  <kbd className="ml-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-medium dark:bg-black/10">
                    C
                  </kbd>
                )}
              </span>
```

`tool-check-pop` already exists in `src/index.css` (line 1525) and is used by `ChatMessage.tsx`; nothing new is added there. The 6 s auto-copy hold (`AUTO_COPY_FEEDBACK_MS`) is unchanged.

- [ ] **Step 4: Run the test, then capture**

Run: `npm test -- test/hooks/useCrossfadedLabel.test.js && npm run typecheck && npm run lint`
Expected: pass.

Capture: let a reply auto-copy (or press C). Grade against **Copy tick** ("tick pops in; 6s hold; label crossfades 320ms back").

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCrossfadedLabel.ts src/components/dictation/AssistantPanel.tsx test/hooks/useCrossfadedLabel.test.js
git commit -m "feat(motion): the copy tick pops in and its label crossfades back over 320ms"
```

---

### Task 7: Panel close — one spring to the pill's circle; the companion fades on the same clock

**Files:**
- Modify: `src/hooks/useAssistantPanel.js` (constants at lines 11–12; `completeContentFade`, `beginClose`; new `completeCollapse`)
- Modify: `src/components/dictation/VoiceModePanelCore.tsx` (`onCollapsed` prop; transitionend capture)
- Modify: `src/components/dictation/AssistantPanel.tsx` (`closing` prop → actions retreat duration)
- Modify: `src/helpers/voicePillPresentation.js` (`resolveAgentModeActive` gains `assistantPanelClosing`)
- Modify: `src/App.jsx` (pass `closing`, `onCollapsed`, `assistantPanelClosing`)
- Modify: `src/styles/dictation-panel.css` (assistant children fade 120 ms with a 4 px drop; companion window fade)
- Modify: `src/helpers/windowManager.js` (`hideAgentDictationPill` defers behind the fade; `showAgentDictationPill` cancels), `preload.js`, `src/types/electron.ts`, `src/components/dictation/AgentDictationPillOverlay.tsx`
- Test: `test/helpers/voicePillPresentation.test.js` (agent identity during close), `test/helpers/windowManagerCompanionFade.test.js` (new)

**Interfaces:**
- Consumes: Task 4's closed clip (the spring shuts to the circle), `--voice-pill-travel-ease` (Task 4), `MOTION_TIMING.morphMs/closeFadeMs/companionFadeMs`.
- Produces:
  - `useAssistantPanel()` returns an extra `completeCollapse: () => void`; `ASSISTANT_CONTENT_FADE_FALLBACK_MS = 160`, `ASSISTANT_COLLAPSE_FALLBACK_MS = 560`.
  - `VoiceModePanelCore` prop `onCollapsed?: () => void` — fired once when the shell's own `clip-path` transition ends while `closing && !open && mode === "assistant"`.
  - `AssistantPanel` prop `closing: boolean`.
  - `resolveAgentModeActive({ …, assistantPanelClosing = false, heldThroughHide = false })` → `Boolean((isAssistantVoice && (isRecording || isProcessing)) || (assistantPanelMounted && !assistantPanelClosing) || heldThroughHide)` (`heldThroughHide` is wired in Task 8).
  - Preload: `onAgentDictationPillWillHide(cb)`, `onAgentDictationPillWillShow(cb)`; main channels `agent-dictation-pill-will-hide`, `agent-dictation-pill-will-show`.

Sequence after this task (≈ 560 ms): close intent → actions retreat + content fade 120 ms (`data-panel-closing`) → `completeContentFade` sets `open=false` → the shell springs shut to the pill's circle over 440 ms while the pill glides to its resting dock on the same spring and the agent colour fades inside it (agent identity ends at close intent, so the 480 ms leaf→ring morph runs inside the close) → the shell's `clip-path` `transitionend` → `completeCollapse` unmounts → the size owner's "returning from panel" path requests `BASE` immediately (window shrinks after the spring, never during). The companion pill, when present, fades 160 ms from close intent and its native window hides after.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/voicePillPresentation.test.js`:

```js
test("Agent identity ends at close intent so the colour fades inside the close spring", async () => {
  const { resolveAgentModeActive } = await load();
  const base = { isAssistantVoice: false, isRecording: false, isProcessing: false };
  assert.equal(resolveAgentModeActive({ ...base, assistantPanelMounted: true }), true);
  assert.equal(
    resolveAgentModeActive({ ...base, assistantPanelMounted: true, assistantPanelClosing: true }),
    false
  );
  // A live agent request keeps its identity even while a stale panel closes.
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: true,
      isRecording: true,
      isProcessing: false,
      assistantPanelMounted: true,
      assistantPanelClosing: true,
    }),
    true
  );
});
```

Create `test/helpers/windowManagerCompanionFade.test.js` — copy the `Module._load` stub block from `test/helpers/windowManagerHandsFree.test.js` verbatim (top of file through the restore), then:

```js
const WindowManager = require("../../src/helpers/windowManager");

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

function managerWithPill() {
  const manager = new WindowManager();
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/helpers/voicePillPresentation.test.js test/helpers/windowManagerCompanionFade.test.js`
Expected: the new identity case fails (`true !== false`); the companion test fails (`hide()` is immediate, no `will-hide` message).

- [ ] **Step 3: Implement the renderer close**

`src/helpers/voicePillPresentation.js`:

```js
/**
 * Keep Agent identity for the complete request lifecycle and the open panel,
 * end it at close intent so the colour fades inside the close spring, and
 * hold it through an auto-hide exit when asked (the mark leaves with the
 * pill; the leaf→ring morph runs while the window is hidden). Never let the
 * audio manager's last routing flag brand a later idle dictation pill.
 */
export function resolveAgentModeActive({
  isAssistantVoice,
  isRecording,
  isProcessing,
  assistantPanelMounted,
  assistantPanelClosing = false,
  heldThroughHide = false,
}) {
  return Boolean(
    (isAssistantVoice && (isRecording || isProcessing)) ||
      (assistantPanelMounted && !assistantPanelClosing) ||
      heldThroughHide
  );
}
```

`src/hooks/useAssistantPanel.js`:

- Constants: `const ASSISTANT_COLLAPSE_FALLBACK_MS = 560;` (replaces `ASSISTANT_TRANSITION_MS = 320`), `const ASSISTANT_CONTENT_FADE_FALLBACK_MS = 160;`.
- New callback, defined before `completeContentFade`:

```js
  // The shell reports its own clip-path transitionend (VoiceModePanelCore
  // onCollapsed); the timer set by completeContentFade is only the fallback.
  const completeCollapse = useCallback(() => {
    if (!closingRef.current || !contentFadeCompletedRef.current) return;
    clearTimeout(closeTimerRef.current);
    closingRef.current = false;
    setClosing(false);
    setMounted(false);
  }, []);
```

- In `completeContentFade`, replace the `closeTimerRef.current = setTimeout(() => { … setMounted(false); }, ASSISTANT_TRANSITION_MS);` block with `closeTimerRef.current = setTimeout(completeCollapse, ASSISTANT_COLLAPSE_FALLBACK_MS);` and add `completeCollapse` to its dependency array.
- In `beginClose`, right after `setClosing(true);`, retreat the footer actions when they own the footer: `if (previousResponseReadyRef.current) setFooterPhase("actions-exiting");` (the footer effect's `!open` branch will reset the phase to `"pill"` when `open` flips false at `completeContentFade`; the actions keyframe finishes in 120 ms — see the CSS variable below).
- Return `completeCollapse` from the hook.

`src/components/dictation/VoiceModePanelCore.tsx`: add `onCollapsed?: () => void` to the props and extend `handleTransitionEndCapture` — before the existing early return add:

```ts
    if (
      closing &&
      !open &&
      mode === "assistant" &&
      event.propertyName === "clip-path" &&
      event.target === event.currentTarget
    ) {
      onCollapsed?.();
      return;
    }
```

`src/components/dictation/AssistantPanel.tsx`: accept `closing: boolean`; on the `.assistant-response-actions` container's `style`, set `"--assistant-actions-retreat-duration": \`${closing ? MOTION_TIMING.closeFadeMs : ASSISTANT_FOOTER_TRANSITION_TIMING.actionsRetreatMs}ms\``.

`src/App.jsx`: pass `closing={assistant.closing}` to `AssistantPanel`, `onCollapsed={assistant.completeCollapse}` to `VoiceModePanelCore`, and `assistantPanelClosing: assistant.closing` into `resolveAgentModeActive`.

CSS (`dictation-panel.css`, the assistant children rules at lines ~38–46):

```css
.expanding-panel-surface[data-panel-mode="assistant"] > * {
  transition:
    opacity var(--motion-close-fade-ms, 120ms) ease-out,
    transform 160ms ease-out;
}

.expanding-panel-surface[data-panel-mode="assistant"][data-panel-closing="true"] > * {
  pointer-events: none;
  opacity: 0;
  transform: translateY(4px);
}
```

Reduced motion: add `.expanding-panel-surface[data-panel-mode="assistant"] > * { transition-duration: 1ms !important; }`.

- [ ] **Step 4: Implement the companion fade**

`src/helpers/windowManager.js`:

```js
const AGENT_DICTATION_PILL_FADE_MS = 160;
…
  hideAgentDictationPill() {
    const pillWindow = this.agentDictationPillWindow;
    if (!pillWindow || pillWindow.isDestroyed()) return;
    if (this._agentDictationPillHideTimer) return;
    if (pillWindow.isVisible() && this._agentDictationPillReady) {
      // Fade on the renderer's clock with the panel close instead of a hard
      // cut; the native hide follows once the fade has had time to land.
      pillWindow.webContents.send("agent-dictation-pill-will-hide");
      this._agentDictationPillHideTimer = setTimeout(() => {
        this._agentDictationPillHideTimer = null;
        this._hideAgentDictationPillNow();
      }, AGENT_DICTATION_PILL_FADE_MS + 20);
      return;
    }
    this._hideAgentDictationPillNow();
  }

  _hideAgentDictationPillNow() {
    const pillWindow = this.agentDictationPillWindow;
    if (!pillWindow || pillWindow.isDestroyed()) return;
    if (pillWindow.isVisible()) pillWindow.hide();
    if (this._agentDictationPillReady) pillWindow.webContents.send("preview-hide");
    this._applyAgentDictationPillClickThrough(pillWindow, true);
    this._agentDictationPillSize = AGENT_DICTATION_PILL_SIZE;
    this.positionAgentDictationPill();
  }
```

In `showAgentDictationPill()` (line ~2039), at the top of the ready path (just before `this.positionAgentDictationPill();` at line ~2118): `clearTimeout(this._agentDictationPillHideTimer); this._agentDictationPillHideTimer = null; if (this._agentDictationPillReady) pillWindow.webContents.send("agent-dictation-pill-will-show");`. Initialise `this._agentDictationPillHideTimer = null;` in the constructor next to `_agentDictationPillReady`.

`preload.js`, next to `onAgentDictationPillStateChanged`:

```js
  onAgentDictationPillWillHide: registerListener("agent-dictation-pill-will-hide", (callback) => () => callback()),
  onAgentDictationPillWillShow: registerListener("agent-dictation-pill-will-show", (callback) => () => callback()),
```

`src/types/electron.ts`: `onAgentDictationPillWillHide?: (callback: () => void) => () => void;` and the same for `WillShow`.

`AgentDictationPillOverlay.tsx`: `const [exiting, setExiting] = useState(false);` subscribed in the existing state effect (`onAgentDictationPillWillHide → setExiting(true)`, `onAgentDictationPillWillShow → setExiting(false)`, and `visibilitychange` to hidden → `setExiting(false)`); the root `<main>` gets `data-exiting={exiting || undefined}`. CSS in `src/styles/agent-dictation-pill.css`:

```css
.agent-dictation-pill-window {
  transition: opacity var(--motion-companion-fade-ms, 160ms) ease-out;
}
.agent-dictation-pill-window[data-exiting="true"] {
  opacity: 0;
  pointer-events: none;
}
```

- [ ] **Step 5: Run the tests, then capture**

Run: `npm test -- test/helpers/voicePillPresentation.test.js test/helpers/windowManagerCompanionFade.test.js test/helpers/windowManagerAssistantPanel.test.js && npm run typecheck && npm run lint`
Expected: pass.

Capture: close the panel (Close button, Escape, and a click on the pill) with auto-hide off, once with a companion recording in flight. Grade against **Panel close** ("actions retreat + fade 120; one spring shell → pill's circle at the resting dock, colour fading inside it; window shrinks on transitionend; ≈560 ms") and **Companion pill on close** ("fades 160 ms on the same clock"). Bounds: `ASSISTANT → BASE` happens after the spring, never during; the total from close intent to rest ≈ 560 ms (read the screencast timestamps).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useAssistantPanel.js src/components/dictation/VoiceModePanelCore.tsx src/components/dictation/AssistantPanel.tsx src/helpers/voicePillPresentation.js src/App.jsx src/styles/dictation-panel.css src/styles/agent-dictation-pill.css src/helpers/windowManager.js preload.js src/types/electron.ts src/components/dictation/AgentDictationPillOverlay.tsx test/helpers/voicePillPresentation.test.js test/helpers/windowManagerCompanionFade.test.js
git commit -m "feat(motion): the agent panel closes in one spring to the pill; the companion fades with it

Close used to be four clocks (fade, shell, unmount timer, window timer)
ending in a jump. Now the actions and content fade 120ms, one spring
carries the shell down to the pill's circle at its resting dock with the
agent colour fading inside it, and the window shrinks when that spring
ends. The companion pill fades on the same clock instead of cutting."
```

---

### Task 8: Decision 8 — hold the agent mark through an auto-hide exit

**Files:**
- Modify: `src/App.jsx` (held-through-hide state; assistant close wrapper; clears)
- Test: `test/helpers/voicePillPresentation.test.js` (the resolver cases spec §4 asks for)

**Interfaces:**
- Consumes: `resolveAgentModeActive({ heldThroughHide })` (Task 7), `floatingIconAutoHide`, `assistant.handleClose`, the auto-hide effect's `hideWindow` call (which Task 9 turns into the zoop path).
- Produces: App state `agentMarkHeldThroughHide` and the clearing rules: after the `hideWindow` IPC resolves, on any new recording start (`isRecording || isPreparing`), or when auto-hide is switched off while the pill is still visible.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/voicePillPresentation.test.js`:

```js
test("a held agent mark survives the panel unmount until released, and a recording start wins", async () => {
  const { resolveAgentModeActive } = await load();
  const idle = { isAssistantVoice: false, isRecording: false, isProcessing: false };
  // Held → true after the unmount.
  assert.equal(
    resolveAgentModeActive({ ...idle, assistantPanelMounted: false, heldThroughHide: true }),
    true
  );
  // Cleared → false.
  assert.equal(
    resolveAgentModeActive({ ...idle, assistantPanelMounted: false, heldThroughHide: false }),
    false
  );
  // A new dictation recording is the dictation ring regardless of the hold
  // (App clears the hold on recording start; the resolver alone must not
  // brand it): with the hold cleared, a plain recording is not agent.
  assert.equal(
    resolveAgentModeActive({
      isAssistantVoice: false,
      isRecording: true,
      isProcessing: false,
      assistantPanelMounted: false,
      heldThroughHide: false,
    }),
    false
  );
});
```

- [ ] **Step 2: Run the test to verify it passes with Task 7's resolver** (this test pins behaviour; the App wiring below is what makes it real)

Run: `npm test -- test/helpers/voicePillPresentation.test.js`
Expected: pass.

- [ ] **Step 3: Wire it in `App.jsx`**

```js
  // Decision 8: with auto-hide on, an agent panel close is the last thing the
  // user sees before the pill leaves. Keep the leaf through the close spring
  // and the exit; the leaf→ring morph then runs while the window is hidden.
  const [agentMarkHeldThroughHide, setAgentMarkHeldThroughHide] = useState(false);
  const handleAssistantClose = React.useCallback(() => {
    if (floatingIconAutoHide && assistant.mounted) setAgentMarkHeldThroughHide(true);
    assistant.handleClose();
  }, [floatingIconAutoHide, assistant]);

  useEffect(() => {
    if (isRecording || isPreparing) setAgentMarkHeldThroughHide(false);
  }, [isRecording, isPreparing]);

  useEffect(() => {
    if (!floatingIconAutoHide) setAgentMarkHeldThroughHide(false);
  }, [floatingIconAutoHide]);
```

- Pass `onClose={handleAssistantClose}` to `AssistantPanel` (instead of `assistant.handleClose`).
- `resolveAgentModeActive({ …, assistantPanelClosing: assistant.closing, heldThroughHide: agentMarkHeldThroughHide })`.
- In the auto-hide effect, the hide call becomes `void window.electronAPI?.hideWindow?.().then(() => setAgentMarkHeldThroughHide(false));` (Task 9 replaces this call with the zoop path and keeps the `.then`).

Note: `assistant.handleClose` is also invoked from inside `useAssistantPanel` for the dictation-error downplay path (`beginClose(true)`); that path is not an auto-hide exit and is left alone.

- [ ] **Step 4: Verify and capture**

Run: `npm test -- test/helpers/voicePillPresentation.test.js && npm run typecheck && npm run lint`

Capture with the pill set to auto-hide (Settings → the floating icon auto-hide toggle): ask the agent, close the panel. Grade against **Close · auto-hide on** ("same spring with the agent mark held, then the zoop with the mark still on; the leaf→ring morph runs once the window is hidden" — before Task 9 lands, the hide is still a hard cut, so grade the mark only: no ring appears before the window disappears). Also confirm the unchanged case: stop a plain dictation with auto-hide on → the pill leaves wearing the ring.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx test/helpers/voicePillPresentation.test.js
git commit -m "feat(motion): keep the agent mark through an auto-hide exit

When the pill auto-hides after an agent panel closes, the mark used to
morph back to the dictation ring 20ms before the window cut. The leaf is
now held through the close and the exit and the morph runs while the
window is hidden, so the next show is the dictation pill."
```

---

### Task 9: Hide "zoop" and show "unzoop"

**Files:**
- Create: `src/hooks/usePillExitChoreography.js`
- Modify: `src/App.jsx` (every renderer-initiated hide goes through `hideWithZoop`; pill wrapper attributes)
- Modify: `src/styles/dictation-panel.css` (zoop/unzoop rules)
- Modify: `src/helpers/windowManager.js` (`hideDictationPanel({ animate })`, `_hideMainWindowNow`, `showDictationPanel` cancel + `pill-will-show`), `src/helpers/ipcHandlers.js` (`hide-window` handler → `{ animate: false }`), `preload.js`, `src/types/electron.ts`
- Test: `test/hooks/usePillExitChoreography.test.js`, `test/helpers/windowManagerPillHide.test.js`

**Interfaces:**
- Consumes: `waitForTransitionEnd`, `MOTION_TIMING.zoopMs`, `--motion-zoop-ease/ms`, `--motion-show-ease/ms`.
- Produces:
  - `usePillExitChoreography({ pillPresenceRef }): { exiting: boolean; hideWithZoop: () => Promise<void> }` — `hideWithZoop` sets `exiting`, awaits the wrapper's `transform` transitionend (fallback `zoopMs + 120`), then `await window.electronAPI.hideWindow()`. `exiting` clears on `pill-will-show`, on `visibilitychange` → visible, and on any recording start. Main-initiated hides arrive as `pill-will-hide` and run the same `hideWithZoop`.
  - Main: `hideDictationPanel({ animate = true } = {})` — with `animate`, sends `pill-will-hide` and defers `hide()` by `PILL_HIDE_FALLBACK_MS = 320` unless the renderer's `hide-window` IPC lands first; `showDictationPanel()` cancels a pending deferred hide and sends `pill-will-show`.
  - Preload: `onPillWillHide(cb)`, `onPillWillShow(cb)`.

The zoop: the pill scales to 0.04 toward its own centre with a 2 px squash (`scale(0.04, 0.03)`), opacity out over the last 40 % (80 ms fade after a 120 ms delay), 200 ms in total; then the window hides. On show the window appears (transparent) and the pill springs back over 260 ms with the show spring's 4 % overshoot.

- [ ] **Step 1: Write the failing tests**

`test/hooks/usePillExitChoreography.test.js`:

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

function fakePresence() {
  const listeners = new Set();
  return {
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    settle() {
      for (const fn of [...listeners]) fn({ target: this, propertyName: "transform" });
    },
  };
}

async function mount(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const hideCalls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        hideWindow: async () => {
          hideCalls.push(Date.now());
        },
        onPillWillHide: (cb) => {
          listeners.willHide = cb;
          return () => {};
        },
        onPillWillShow: (cb) => {
          listeners.willShow = cb;
          return () => {};
        },
      },
    },
  });
  const container = installHookDom(t);
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
  return { render, presence, listeners, hideCalls, read: () => result };
}

test("hideWithZoop plays the exit, then hides the window, and stays exited until shown", async (t) => {
  const { presence, hideCalls, listeners, read } = await mount(t);
  let done = false;
  let hiding;
  await React.act(async () => {
    hiding = read().hideWithZoop().then(() => (done = true));
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
```

`test/helpers/windowManagerPillHide.test.js` — copy the `Module._load` stub block from `test/helpers/windowManagerHandsFree.test.js` verbatim, then:

```js
const WindowManager = require("../../src/helpers/windowManager");

function fakeMainWindow() {
  const sent = [];
  let visible = true;
  return {
    sent,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
    hide: () => {
      visible = false;
    },
    showInactive: () => {
      visible = true;
    },
    restore: () => undefined,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

function manager() {
  const m = new WindowManager();
  m.mainWindow = fakeMainWindow();
  m._mainWindowPlacementCoordinator = { cancelPending: () => undefined };
  m._repositionToActiveDisplay = async () => undefined;
  m.enforceMainWindowOnTop = () => undefined;
  return m;
}

test("an animated hide asks the renderer to zoop and hides on the fallback if it never answers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  assert.equal(m.mainWindow.sent.at(-1).channel, "pill-will-hide");
  assert.equal(m.mainWindow.isVisible(), true);
  t.mock.timers.tick(320);
  assert.equal(m.mainWindow.isVisible(), false);
});

test("the renderer's own hide request lands immediately and clears the fallback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.hideDictationPanel({ animate: false });
  assert.equal(m.mainWindow.isVisible(), false);
  t.mock.timers.tick(1000); // no second hide, no throw
});

test("a show during the zoop cancels the pending hide and tells the renderer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = manager();
  m.hideDictationPanel();
  m.showDictationPanel();
  t.mock.timers.tick(1000);
  assert.equal(m.mainWindow.isVisible(), true);
  assert.equal(m.mainWindow.sent.at(-1).channel, "pill-will-show");
});

test("an open assistant panel still refuses the hide", () => {
  const m = manager();
  m._assistantPanelOpen = true;
  m.hideDictationPanel();
  assert.equal(m.mainWindow.sent.length, 0);
  assert.equal(m.mainWindow.isVisible(), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/hooks/usePillExitChoreography.test.js test/helpers/windowManagerPillHide.test.js`
Expected: FAIL — hook module not found; `hide()` immediate with no `pill-will-hide` message.

- [ ] **Step 3: Implement the renderer**

`src/hooks/usePillExitChoreography.js`:

```js
import { useCallback, useEffect, useRef, useState } from "react";
import { MOTION_TIMING } from "../utils/springEasing";
import { waitForTransitionEnd } from "../utils/transitionSettled";

/**
 * The pill leaves with a "zoop" (scale into its own centre) and the native
 * window hides after; on the next show it springs back. `exiting` stays set
 * while hidden so the first visible frame starts from the exited pose.
 * Main-initiated hides arrive as pill-will-hide and run the same sequence.
 */
export function usePillExitChoreography({ pillPresenceRef, recording }) {
  const [exiting, setExiting] = useState(false);
  const inFlightRef = useRef(null);

  const hideWithZoop = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    setExiting(true);
    const run = (async () => {
      await waitForTransitionEnd(
        pillPresenceRef.current,
        "transform",
        MOTION_TIMING.zoopMs + 120
      );
      await window.electronAPI?.hideWindow?.();
    })().finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, [pillPresenceRef]);

  useEffect(() => {
    const unsubscribeHide = window.electronAPI?.onPillWillHide?.(() => {
      void hideWithZoop();
    });
    const unsubscribeShow = window.electronAPI?.onPillWillShow?.(() => setExiting(false));
    const onVisibility = () => {
      if (document.visibilityState === "visible") setExiting(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribeHide?.();
      unsubscribeShow?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hideWithZoop]);

  useEffect(() => {
    if (recording) setExiting(false);
  }, [recording]);

  return { exiting, hideWithZoop };
}
```

In `src/App.jsx`:

- `const pillPresenceRef = useRef(null);` and put `ref={pillPresenceRef}` on the `assistant-pill-presence` div; add `data-pill-exit={pillExit.exiting ? "zoop" : undefined}` to it.
- `const pillExit = usePillExitChoreography({ pillPresenceRef, recording: isRecording || isPreparing });`
- The auto-hide effect's hide becomes `void pillExit.hideWithZoop().then(() => setAgentMarkHeldThroughHide(false));`; `handleClose` (Escape, the menu's Hide) becomes `void pillExit.hideWithZoop();`.

CSS (`dictation-panel.css`, before the reduced-motion block):

```css
/* Exit "zoop": the pill collapses into its own centre with a 2px squash, the
   opacity leaving over the last 40%; the native window hides after. Show is
   the mirror on the show spring (4% overshoot). The origin follows the dock. */
.assistant-pill-presence {
  --pill-exit-origin: calc(100% - 20px) 50%;
  transform-origin: var(--pill-exit-origin);
  transition:
    transform var(--motion-show-ms, 260ms) var(--motion-show-ease, cubic-bezier(0.2, 0, 0, 1)),
    opacity 120ms linear;
}

.assistant-pill-presence[data-horizontal-direction="left"] {
  --pill-exit-origin: 20px 50%;
}

.voice-pill-position-center .assistant-pill-presence {
  --pill-exit-origin: 50% 50%;
}

.assistant-pill-presence[data-pill-exit="zoop"] {
  transform: scale(0.04, 0.03);
  opacity: 0;
  pointer-events: none;
  transition:
    transform var(--motion-zoop-ms, 200ms) var(--motion-zoop-ease, cubic-bezier(0.4, 0, 1, 1)),
    opacity 80ms linear 120ms;
}
```

The wrapper already carries Tailwind's `transition-opacity duration-150`; remove those two utility classes from that div (the rule above owns its transition now) and keep the `pointer-events-none opacity-0` toggle for the in-place-of-pill case, which still works because `opacity-0` is a property, not a transition. Reduced motion: `.assistant-pill-presence, .assistant-pill-presence[data-pill-exit="zoop"] { transition-duration: 1ms !important; transition-delay: 0ms !important; }`.

- [ ] **Step 4: Implement main**

`src/helpers/windowManager.js`:

```js
const PILL_HIDE_FALLBACK_MS = 320;
…
  // The pill zoops out on the renderer's clock and then asks for the hide
  // (hide-window IPC → animate:false). The timer only covers a renderer that
  // never answers. An open (or busy) assistant panel keeps its window.
  hideDictationPanel({ animate = true } = {}) {
    if (this._assistantPanelOpen || this._assistantPanelBusy) return;
    this._mainWindowPlacementCoordinator.cancelPending();
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (!animate || !this.mainWindow.isVisible()) {
      this._hideMainWindowNow();
      return;
    }
    if (this._pillHideTimer) return;
    this.mainWindow.webContents.send("pill-will-hide");
    this._pillHideTimer = setTimeout(() => this._hideMainWindowNow(), PILL_HIDE_FALLBACK_MS);
  }

  _hideMainWindowNow() {
    clearTimeout(this._pillHideTimer);
    this._pillHideTimer = null;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.hide();
  }
```

Initialise `this._pillHideTimer = null;` in the constructor. In `showDictationPanel(options)` (line ~1737), right after the `_onboardingActive` guard: `clearTimeout(this._pillHideTimer); this._pillHideTimer = null;` and, once the window is shown (after the `showInactive()`/`show()` branch), `this.mainWindow.webContents.send("pill-will-show");`.

`src/helpers/ipcHandlers.js` line 1336: `ipcMain.handle("hide-window", () => { this.windowManager.hideDictationPanel({ animate: false }); });`

`preload.js`: `onPillWillHide: registerListener("pill-will-hide", (callback) => () => callback()),` and `onPillWillShow: registerListener("pill-will-show", (callback) => () => callback()),`. `src/types/electron.ts`: the two optional listener signatures.

Every other main-side caller of `hideDictationPanel()` (the push-gesture cancel paths in `windowManager.js`, the Fn-interrupt in `main.js`, the tray toggle) keeps calling it with no argument and therefore gets the zoop.

- [ ] **Step 5: Run the tests, then capture**

Run: `npm test -- test/hooks/usePillExitChoreography.test.js test/helpers/windowManagerPillHide.test.js test/helpers/windowManagerHandsFree.test.js && npm run typecheck && npm run lint`
Expected: pass.

Capture: (a) the menu's "Hide for now" and (b) auto-hide after a dictation, then (c) press the hotkey to bring the pill back. Grade against **Hide** ("zoop: 200ms scale to 0.04 toward the pill's centre with a 2px squash, opacity out over the last 40%; window hides after") and **Show** ("window shows transparent, pill unzoops 260ms with 4% overshoot"). Also re-capture **Close · auto-hide on** from Task 8: the zoop now carries the leaf.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/usePillExitChoreography.js src/App.jsx src/styles/dictation-panel.css src/helpers/windowManager.js src/helpers/ipcHandlers.js preload.js src/types/electron.ts test/hooks/usePillExitChoreography.test.js test/helpers/windowManagerPillHide.test.js
git commit -m "feat(motion): the pill zoops out before the window hides and springs back on show

Hiding was a hard cut. The pill now collapses into its own centre over
200ms and the window hides after; showing springs it back over 260ms.
Hides started by the main process ask the renderer first and fall back
to a plain hide if it never answers."
```

---

### Task 10: Live transcript — opacity-only tail; entrance chained on `transitionend`

**Files:**
- Modify: `src/utils/liveTranscriptPresentation.ts` (add `splitTranscriptForTail`), `src/components/dictation/LiveTranscriptPanel.tsx` (render the tail per word), `src/styles/dictation-panel.css`
- Modify: `src/components/dictation/VoiceModePanelCore.tsx` (`onStageSettled`), `src/hooks/useLiveTranscriptPanel.js` (lines 234–272)
- Modify: `src/App.jsx`, `src/components/dictation/AgentDictationPillOverlay.tsx` (wire `onStageSettled`)
- Test: `test/utils/liveTranscriptPresentation.test.js`

**Interfaces:**
- Produces:
  - `splitTranscriptForTail(text, { activeWordCount = 6, settlingWordCount = 6 }): { settled: string; tail: Array<{ index: number; text: string; active: boolean }> }` — `index` is the absolute word index (stable React key); the last `activeWordCount` words are `active`, the `settlingWordCount` before them are in the tail but not active (so their opacity transition from 0.62 → 1 plays when they leave the active window), everything earlier is `settled` text.
  - `VoiceModePanelCore` prop `onStageSettled?: (stage: "encapsulated" | "footer") => void` — fired on the shell's own `clip-path` transitionend while `mode === "live-transcript"` and `open`, with the stage the shell was in.
  - `useLiveTranscriptPanel()` returns `notifyStageSettled(stage)`; the `horizontal` phase starts on `encapsulated` settled (+ the 140 ms hold), the `controls` phase on `footer` settled (+ `controlsDelayMs`); the existing timers remain as fallbacks at their current instants + 80 ms. Later phases (`prepare`, `panel`, `content`, stream resume) keep their timers unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/utils/liveTranscriptPresentation.test.js`:

```js
test("the tail keeps stable word indices, six active words and six settling words", async () => {
  const { splitTranscriptForTail } = await load();
  const words = Array.from({ length: 15 }, (_, i) => `w${i}`);
  const result = splitTranscriptForTail(words.join(" "));
  assert.equal(result.settled, "w0 w1 w2 ");
  assert.deepEqual(
    result.tail.map((w) => w.index),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  );
  assert.deepEqual(
    result.tail.map((w) => w.active),
    [false, false, false, false, false, false, true, true, true, true, true, true]
  );
  assert.equal(result.tail.at(-1).text, "w14");
});

test("a short transcript is all tail; an empty one is nothing", async () => {
  const { splitTranscriptForTail } = await load();
  const short = splitTranscriptForTail("just four words here");
  assert.equal(short.settled, "");
  assert.deepEqual(short.tail.map((w) => w.active), [true, true, true, true]);
  assert.deepEqual(splitTranscriptForTail("   "), { settled: "", tail: [] });
});
```

(`load` in that file must import `../../src/utils/liveTranscriptPresentation.ts` — check the existing loader at the top and reuse it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/utils/liveTranscriptPresentation.test.js`
Expected: FAIL — `splitTranscriptForTail` is not exported.

- [ ] **Step 3: Implement the tail**

Add to `src/utils/liveTranscriptPresentation.ts`:

```ts
export interface TailWord {
  index: number;
  text: string;
  active: boolean;
}

/**
 * Opacity-only tail: the newest words sit at 62% and settle to 100% when
 * they leave the active window. Words stay individually rendered for a few
 * more positions so that settle can transition instead of stepping, and
 * their absolute index keeps each span stable across deltas.
 */
export function splitTranscriptForTail(
  text: string,
  { activeWordCount = 6, settlingWordCount = 6 } = {}
): { settled: string; tail: TailWord[] } {
  const normalized = text.trim();
  if (!normalized) return { settled: "", tail: [] };
  const words = normalized.split(/\s+/);
  const tailStart = Math.max(0, words.length - activeWordCount - settlingWordCount);
  const activeStart = Math.max(0, words.length - activeWordCount);
  const tail = words.slice(tailStart).map((word, offset) => {
    const index = tailStart + offset;
    return { index, text: word, active: index >= activeStart };
  });
  const settled = tailStart > 0 ? `${words.slice(0, tailStart).join(" ")} ` : "";
  return { settled, tail };
}
```

In `LiveTranscriptPanel.tsx`, replace the `shimmerParts` memo and render:

```tsx
  const tailParts = useMemo(
    () => (shouldShimmer ? splitTranscriptForTail(text) : { settled: text, tail: [] }),
    [shouldShimmer, text]
  );
  …
              <span>{tailParts.settled}</span>
              {tailParts.tail.map((word) => (
                <span
                  key={word.index}
                  className="live-transcript-word"
                  data-active={word.active || undefined}
                >
                  {word.text}{" "}
                </span>
              ))}
```

CSS:

```css
/* Live transcript tail: the newest words sit at 62% and settle to full
   opacity when they leave the active window — an opacity change only, so
   nothing repaints text every frame. */
.live-transcript-word {
  opacity: 1;
  transition: opacity 240ms ease-out;
}

.live-transcript-word[data-active="true"] {
  opacity: 0.62;
}
```

The `.inline-response-shimmer` rule and keyframes stay in the stylesheet (nothing removed); they are no longer referenced by the transcript.

- [ ] **Step 4: Make the entrance event-driven**

`VoiceModePanelCore.tsx`: add `onStageSettled?: (stage: "encapsulated" | "footer") => void`; in `handleTransitionEndCapture`, before the assistant checks:

```ts
    if (
      mode === "live-transcript" &&
      open &&
      event.propertyName === "clip-path" &&
      event.target === event.currentTarget &&
      (stage === "encapsulated" || stage === "footer")
    ) {
      onStageSettled?.(stage);
      return;
    }
```

`useLiveTranscriptPanel.js` (lines 240–248): keep every timer but make the first two gates race the event. Add a `stageGatesRef = useRef({})` and:

```js
        const timeline = getLiveTranscriptEntranceTimeline();
        const gate = (stage, fallbackAtMs) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, fallbackAtMs + 80);
            stageGatesRef.current[stage] = () => {
              clearTimeout(timer);
              resolve();
            };
            entranceTimersRef.current.push(timer);
          });
        void (async () => {
          await gate("encapsulated", LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs);
          if (generation !== openGenerationRef.current) return;
          await new Promise((r) => {
            const t = setTimeout(r, LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateHoldMs);
            entranceTimersRef.current.push(t);
          });
          if (generation !== openGenerationRef.current) return;
          setEntrancePhase("horizontal");
          await gate("footer", LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs);
          if (generation !== openGenerationRef.current) return;
          await new Promise((r) => {
            const t = setTimeout(r, LIVE_TRANSCRIPT_ENTRANCE_TIMING.controlsDelayMs);
            entranceTimersRef.current.push(t);
          });
          if (generation !== openGenerationRef.current) return;
          setEntrancePhase("controls");
        })();
```

and remove the two `setTimeout(() => setEntrancePhase("horizontal"|"controls"), …)` entries; the `prepare` timer and everything after it stay exactly as they are (their instants are unchanged). Expose:

```js
  const notifyStageSettled = useCallback((stage) => {
    stageGatesRef.current[stage]?.();
    delete stageGatesRef.current[stage];
  }, []);
```

and clear `stageGatesRef.current = {}` wherever `entranceTimersRef` is cleared. Return `notifyStageSettled`.

`App.jsx` and `AgentDictationPillOverlay.tsx`: pass `onStageSettled={liveTranscript.notifyStageSettled}` to their `VoiceModePanelCore`.

- [ ] **Step 5: Run the tests, then capture**

Run: `npm test -- test/utils/liveTranscriptPresentation.test.js test/helpers/voicePillPresentation.test.js && npm run typecheck && npm run lint`
Expected: pass (the entrance timeline test is order-only and unchanged).

Capture a live-transcript session with local transcription. Grade against **Live transcript tail** ("opacity-only tail 62% → 100% on commit; entrance stages and durations unchanged"): the entrance filmstrip must be frame-equivalent to the ground-truth strip at every stage boundary (same instants ± one frame), and the streaming text shows no stepped sweep.

- [ ] **Step 6: Commit**

```bash
git add src/utils/liveTranscriptPresentation.ts src/components/dictation/LiveTranscriptPanel.tsx src/styles/dictation-panel.css src/components/dictation/VoiceModePanelCore.tsx src/hooks/useLiveTranscriptPanel.js src/App.jsx src/components/dictation/AgentDictationPillOverlay.tsx test/utils/liveTranscriptPresentation.test.js
git commit -m "feat(motion): live transcript tail settles by opacity; entrance chains on transitionend

The newest words sit at 62% and settle to full opacity when they leave
the active window, replacing the stepped background-clip sweep. The
entrance keeps every stage and duration; its first two beats now start
when the surface reports its transition finished, with the old timers as
fallbacks."
```

---

### Task 11: Full verification and the stacked PR

- [ ] **Step 1: Suite and checks**

Run: `npm test 2>&1 | tail -20 && npm run typecheck && npm run lint`
Expected: everything passes except the one known environmental failure.

- [ ] **Step 2: Re-capture every transition on a fresh rig build of the branch head**

Using `ow-ui-capture`, record all ten rows (listening entrance, stop → idle, panel open, streaming reply, copy tick, panel close, companion on close, hide, show, live transcript tail) plus decision 8 (close with auto-hide on) in one session, each graded against its design-page row with the three pass conditions (anatomy, ≤34 ms frames, constant bounds). Record the rAF probe numbers per row.

- [ ] **Step 3: Reduced motion**

With "Reduce motion" on in macOS Accessibility, click through the same set: every transition must complete in a frame or two with no stuck state (in particular: the panel must still unmount — the collapse fallback covers a 1 ms transition whose `transitionend` fires immediately — and the pill must still hide and show).

- [ ] **Step 4: Open the PR**

`git push -u origin feature/hold-motion`, then open a PR with base `feature/hotkey-activation-modes`, title "Hold and Hands-free: retimed pill and panel motion", and a body that, for a non-technical reader, explains what each commit changes and why, with a table: commit → design-page row → probe result (worst frame, missed frames) → capture link. Note the Task 2 decision (spring-eased width transition instead of the literal clip-path reveal, and why) for Josh's call. Do not merge.

- [ ] **Step 5: Hand back**

Report to Josh: branch head, the per-row probe table, anything that failed grading, and the two open threads recorded in the spec (onboarding cross-check after the build; Linux Hold parity).

---

## Self-review against the spec (done while writing)

- §3 principles (transform/opacity/clip-path; no resize during a visible transition; transitionend chaining; springs as `linear()`; reduced motion; nothing removed): Task 1 (utilities), Tasks 3/4/7 (resize timing), every task's reduced-motion line; the one deliberate exception (Task 2 keeps the existing width transition, re-eased) is flagged for Josh.
- §3 table rows: listening entrance (T2), stop → idle (T3), panel open (T4), streaming reply (T5), copy tick (T6), panel close (T7), companion on close (T7), hide (T9), show (T9), live transcript tail (T10).
- §3 decision 8 (`heldThroughHide` on `resolveAgentModeActive`; set at close intent when auto-hide is on and the panel was the agent's; cleared after `hideWindow` resolves, on a new recording start, or when auto-hide is switched off; renderer only): Tasks 7 and 8.
- §4 unit: `resolveAgentModeActive` cases (T7, T8); `pressGesture.test.js` and `windowSizeLadder.test.js` untouched. §4 frame-level: every task's capture step; T11 re-runs them all.
- Placeholder scan: every step carries code or an exact command; captures name their design-page row.
- Type consistency: `MOTION_TIMING` / `MOTION_EASING` / `motionCssVariables` (T1 → T2, T4, T5, T6, T7, T9); `waitForTransitionEnd` (T1 → T3, T9); `onCollapsed` / `completeCollapse` (T7); `onStageSettled` / `notifyStageSettled` (T10); `assistantPanelClosing` / `heldThroughHide` (T7, T8); `hideWithZoop` / `pill-will-hide` / `pill-will-show` (T9).
