const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderStatic } = require("./harness/reactSsr");

const sourceRoot = path.resolve(__dirname, "../..");
// The dictation-window feature styles are split out of index.css; selectors
// under test may live in either file.
const readDictationStyles = () =>
  fs.readFileSync(path.join(sourceRoot, "src/index.css"), "utf8") +
  fs.readFileSync(path.join(sourceRoot, "src/styles/dictation-panel.css"), "utf8");

// dictation-panel.css alone, for assertions that must be anchored to ITS OWN
// structure (e.g. "is this rule inside dictation-panel.css's own media
// query"). readDictationStyles() concatenates index.css FIRST, and index.css
// has its own, earlier, unrelated `@media (prefers-reduced-motion: reduce)`
// block — so an indexOf anchor against the combined string always finds
// index.css's block first, making "is this after the media query's start"
// vacuously true for every byte of dictation-panel.css, wherever it actually
// lives (Finding 2, review 2026-09-08: proven by relocating the rule outside
// dictation-panel.css's own media block and observing the suite stay green).
const readDictationPanelCss = () =>
  fs.readFileSync(path.join(sourceRoot, "src/styles/dictation-panel.css"), "utf8");

// Extracts the full text of one top-level `@media (...) { ... }` block from
// `source` by matching braces, not merely the next "}" (a media query
// contains multiple nested rule blocks, each with its own closing brace).
// Returns null if the selector text or a balanced closing brace isn't found.
const extractMediaBlock = (source, mediaSelectorText) => {
  const start = source.indexOf(mediaSelectorText);
  if (start < 0) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return null;
  let depth = 1;
  let i = openBrace + 1;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") depth -= 1;
  }
  if (depth !== 0) return null;
  return source.slice(start, i);
};

// The pill renders the resting silhouette and the live waveform as two
// stacked bar sets, both sized from the shared bar count.
const totalWaveBars = async () => {
  const { WAVEFORM_BAR_COUNT } = await import("../../src/components/dictation/waveformMath.ts");
  return WAVEFORM_BAR_COUNT * 2;
};

// The pill's rendered footprints are a native-window contract (see
// VOICE_PILL_FOOTPRINT); every footprint assertion derives from the exported
// constants so the literals live in exactly one place.
const pillFootprints = async () => {
  const { VOICE_PILL_FOOTPRINT } = await import("../../src/helpers/voicePillPresentation.js");
  const asStyle = ({ width, height }) => new RegExp(`style="width:${width}px;height:${height}px`);
  return {
    idle: asStyle(VOICE_PILL_FOOTPRINT.idle),
    recording: asStyle(VOICE_PILL_FOOTPRINT.recording),
  };
};

const renderPill = async (state, expanded, horizontalDirection = "right", overrides = {}) => {
  const { VoicePill } = await import("../../src/components/dictation/VoicePill.tsx");
  return renderStatic(VoicePill, {
    variant: "floating",
    state,
    expanded,
    horizontalDirection,
    getAudioLevel: () => 0,
    ...overrides,
  });
};

const renderVoiceModePanelCore = async (overrides = {}) => {
  const { VoiceModePanelCore } = await import(
    "../../src/components/dictation/VoiceModePanelCore.tsx"
  );
  return renderStatic(VoiceModePanelCore, {
    mode: null,
    open: false,
    onPreferredHeightChange: () => {},
    ...overrides,
  });
};

// The listening entrance's widening and the waveform's reveal are pinned to
// Task 1's spring easings (springEasing.ts). Both snippets derive from the
// same exported constants the implementation consumes, so a drift in either
// constant — not a copy-pasted literal — is what would break this test.
const motionTransitionSnippets = async () => {
  const { LISTENING_ENTRANCE_TIMING } = await import("../../src/helpers/voicePillPresentation.js");
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  return {
    widen: `transition:width ${LISTENING_ENTRANCE_TIMING.expansionMs}ms var(--motion-morph-ease`,
    waveformSlide: `transform ${MOTION_TIMING.showMs}ms var(--motion-show-ease`,
  };
};

test("thinking and recording keep the same persistent glow and pill roots", async () => {
  const thinking = await renderPill("thinking", false);
  const recording = await renderPill("recording", true);

  for (const markup of [thinking, recording]) {
    assert.match(markup, /^<span class="voice-pill-glow-anchor"/);
    assert.match(markup, /class="processing-signal-glow"/);
    assert.match(markup, /voice-pill-control/);
  }
  assert.match(thinking, /class="processing-signal-glow" data-active="true"/);
  assert.doesNotMatch(recording, /data-active/);
  const expectedBars = await totalWaveBars();
  assert.equal((thinking.match(/rounded-full bg-current/g) || []).length, expectedBars);
  assert.equal((recording.match(/rounded-full bg-current/g) || []).length, expectedBars);
});

test("one Signal glow serves both identities: blue processing, purple agent", async () => {
  const styles = readDictationStyles();
  const agentThinking = await renderPill("thinking", false, "right", { agentMode: true });
  // Listening must not glow in either identity: a glow before any transcript
  // exists reads as work already in flight.
  const agentListening = await renderPill("recording", false, "right", { agentMode: true });

  assert.match(styles, /\.processing-signal-glow\s*\{/);
  assert.match(styles, /:root:not\(\.dark\) \.processing-signal-glow\s*\{/);
  assert.match(
    agentThinking,
    /class="processing-signal-glow" data-active="true" data-agent="true"/
  );
  assert.doesNotMatch(agentListening, /data-active/);
});

test("the pill renders exactly the footprints the native window ladder is sized around", async () => {
  const footprint = await pillFootprints();
  const idle = await renderPill("idle", false);
  const recording = await renderPill("recording", true);

  assert.match(idle, footprint.idle);
  assert.doesNotMatch(idle, footprint.recording);
  assert.match(recording, footprint.recording);
  assert.doesNotMatch(recording, footprint.idle);
});

test("panel thinking contracts to the identity circle instead of freezing a waveform", async () => {
  const footprint = await pillFootprints();
  const panelThinking = await renderPill("thinking", false, "right", {
    variant: "panel",
    agentMode: true,
  });

  assert.match(panelThinking, footprint.idle);
  assert.match(panelThinking, /data-agent-beam-active="true"/);
  assert.doesNotMatch(panelThinking, footprint.recording);
});

test("an idle Agent panel starts with the normal pill and expands only while listening", async () => {
  const footprint = await pillFootprints();
  const idleAgent = await renderPill("idle", false, "right", {
    variant: "panel",
    agentMode: true,
    waveformOnlyWhileRecording: true,
  });
  const listeningAgent = await renderPill("recording", false, "right", {
    variant: "panel",
    agentMode: true,
    waveformOnlyWhileRecording: true,
  });

  assert.match(idleAgent, footprint.idle);
  assert.doesNotMatch(idleAgent, footprint.recording);
  assert.doesNotMatch(idleAgent, /data-active/);
  assert.match(listeningAgent, footprint.recording);
  assert.doesNotMatch(listeningAgent, /data-active/);
});

test("the waveform stays to the right of the identity across docks and voice modes", async () => {
  const right = await renderPill("recording", true, "right");
  const left = await renderPill("recording", true, "left");
  const leftAgent = await renderPill("recording", true, "left", {
    agentMode: true,
  });
  const leftLiveTranscript = await renderPill("recording", true, "left", {
    variant: "panel",
    integratedWithPanel: true,
  });

  assert.match(right, /data-horizontal-direction="right"/);
  assert.match(right, /voice-pill-control[^"\n]*pr-1/);
  assert.match(left, /data-horizontal-direction="left"/);
  assert.match(left, /voice-pill-control[^"\n]*pr-1/);

  for (const markup of [right, left, leftAgent, leftLiveTranscript]) {
    assert.doesNotMatch(markup, /flex-row-reverse/);
    assert.ok(markup.indexOf("voice-pill-identity-slot") >= 0);
    assert.ok(markup.indexOf("voice-pill-waveform") > markup.indexOf("voice-pill-identity-slot"));
  }
});

test("the collapsed Live Transcript pill transitions its logo into an expand chevron", async () => {
  const resting = await renderPill("recording", true);
  const hovered = await renderPill("recording", true, "right", {
    showExpandChevron: true,
  });
  const leftHovered = await renderPill("recording", true, "left", {
    showExpandChevron: true,
  });

  assert.doesNotMatch(resting, /data-expand-chevron/);
  assert.match(resting, /voice-pill-identity-logo[^"\n]*scale-100 opacity-100/);
  assert.match(resting, /voice-pill-expand-chevron[^"\n]*opacity-0/);
  assert.match(hovered, /data-expand-chevron="true"/);
  assert.match(hovered, /voice-pill-identity-logo[^"\n]*opacity-0/);
  assert.match(hovered, /voice-pill-expand-chevron[^"\n]*scale-100 opacity-100/);
  assert.doesNotMatch(leftHovered, /flex-row-reverse/);
  assert.ok(
    leftHovered.indexOf("voice-pill-expand-chevron") < leftHovered.indexOf("voice-pill-waveform")
  );
});

test("the idle pill keeps the logo at normal foreground strength", async () => {
  const idle = await renderPill("idle", false);

  assert.match(idle, /border-border-hover[^"\n]*dark:border-border\/50/);
  assert.match(
    idle,
    /voice-identity-icon relative inline-block shrink-0 transition-\[width,height\] duration-200 text-foreground/
  );
});

test("the floating hover pill changes surface treatment without zooming", async () => {
  const footprint = await pillFootprints();
  const hovered = await renderPill("hover", false);

  assert.match(hovered, /border-border-hover bg-surface-3 text-foreground/);
  assert.match(hovered, /box-shadow:var\(--shadow-card-hover-subtle\)/);
  // Structural, not positional: compare the full set of transform-bearing
  // style attributes against the idle render, anywhere in the subtree — not
  // just a regex scoped to one element or anchored to one attribute order.
  // The waveform reveal's inline transform (its armed pre-slide offset,
  // invisible via opacity until the reveal) is identical in both states, so
  // it cancels out of the comparison; any transform hover actually adds —
  // on the control, on some other element, at any attribute position — does
  // not.
  const transformStyles = (markup) => (markup.match(/style="[^"]*transform:[^"]*"/g) || []).sort();
  assert.deepEqual(transformStyles(hovered), transformStyles(await renderPill("idle", false)));
  assert.match(hovered, footprint.idle);
  assert.match(hovered, /<svg width="22" height="22"/);
});

test("the listening entrance widening and the waveform reveal reference the pinned spring easings", async () => {
  const snippets = await motionTransitionSnippets();
  const pill = await renderPill("recording", true);

  // The control's width transition (also height/padding, driven by the same
  // GROW_TRANSITION constant) actually plays the morph spring — not just a
  // duration that happens to match it.
  assert.ok(
    pill.includes(snippets.widen),
    `expected the control's transition to include "${snippets.widen}"`
  );
  // The waveform's slide-in actually plays the show spring, over its own
  // pinned duration — not the morph spring's, and not a hardcoded literal.
  assert.ok(
    pill.includes(snippets.waveformSlide),
    `expected the waveform's transition to include "${snippets.waveformSlide}"`
  );
});

// Task 4: the shared expanding-panel-surface's closed state IS the pill's own
// 40px circle at the resting dock (not the old invisible corner-box), and
// opening springs it open on the pinned morph spring. Exact multi-line
// substring matches (not a loose regex) so a revert to a hardcoded
// cubic-bezier literal, a duration drift, or a dropped var name all fail this
// the same way the Task 2 review's near-miss should have been caught.
test("the pill-to-panel surface closes to the pill's own circle and springs open on the morph spring", async () => {
  const styles = readDictationStyles();
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { VOICE_PILL_FOOTPRINT } = await import("../../src/helpers/voicePillPresentation.js");

  // Derived from VOICE_PILL_FOOTPRINT.idle — the single source of truth the
  // native window ladder is ALSO sized around (see its own dedicated test
  // above) — rather than repeating 40/20 as literals a second time. Finding
  // 3 (review 2026-09-08): two independently-hardcoded copies of the same
  // magic number mean a future pill resize passes both silently, springing
  // the panel from a wrong-sized circle with every test green.
  const pillDiameter = VOICE_PILL_FOOTPRINT.idle.width;
  assert.equal(
    VOICE_PILL_FOOTPRINT.idle.height,
    pillDiameter,
    "sanity: the closed-circle trick (inset(...) round <radius>) only produces a TRUE circle if the idle pill is square"
  );
  const pillRadius = pillDiameter / 2;

  const closedSurfaceRule = [
    ".expanding-panel-surface {",
    `  clip-path: inset(calc(100% - ${pillDiameter}px) 0 0 calc(100% - ${pillDiameter}px) round ${pillRadius}px);`,
    "  opacity: 1;",
    "  pointer-events: none;",
    "  transform: none;",
    "  transition:",
    `    clip-path var(--motion-morph-ms, ${MOTION_TIMING.morphMs}ms) var(--motion-morph-ease, cubic-bezier(0.2, 0, 0, 1)),`,
    "    opacity 180ms linear,",
    `    transform var(--motion-morph-ms, ${MOTION_TIMING.morphMs}ms) var(--motion-morph-ease, cubic-bezier(0.2, 0, 0, 1));`,
    "  will-change: clip-path, opacity, transform;",
    "}",
  ].join("\n");
  assert.ok(
    closedSurfaceRule.includes("var(--motion-morph-ease,"),
    "sanity: the expected snippet itself must reference the pinned morph ease variable"
  );
  assert.ok(
    styles.includes(closedSurfaceRule),
    "expected the shared closed state to be exactly the pill's circle, springing open on the pinned morph spring"
  );

  // Nothing is mounted at rest (no data-panel-mode attribute at all): the
  // shell hides instead of showing an empty circle under the pill.
  assert.ok(
    styles.includes(
      [".expanding-panel-surface:not([data-panel-mode]) {", "  visibility: hidden;", "}"].join("\n")
    ),
    "expected the surface to stay hidden while nothing is mounted"
  );

  // Each dock's anchor only needs to flip the clip-path's kept corner now —
  // the transform nudge moved to Live Transcript's own scoped closed state
  // below, since the shared circle never needs one.
  assert.ok(
    styles.includes(
      [".expanding-panel-anchor-bottom-right {", "  transform-origin: bottom right;", "}"].join(
        "\n"
      )
    ),
    "expected the right anchor to carry only a transform-origin now"
  );
  assert.ok(
    styles.includes(
      [
        ".expanding-panel-anchor-bottom-left {",
        `  clip-path: inset(calc(100% - ${pillDiameter}px) calc(100% - ${pillDiameter}px) 0 0 round ${pillRadius}px);`,
        "  transform-origin: bottom left;",
        "}",
      ].join("\n")
    ),
    "expected the left anchor's closed clip-path to keep the pill's bottom-left corner instead"
  );
});

// The old corner-box closed state (52px/108px inset, 4px translate nudge) is
// not deleted — Live Transcript's entrance is out of scope for this task and
// must render identically, so that geometry survives, just rescoped to
// data-panel-mode="live-transcript" and gated to the closed (:not(...-open))
// state instead of living in the mode-agnostic base rule.
test("Live Transcript's own closed corner-box geometry survives Task 4, rescoped to its own mode", async () => {
  const styles = readDictationStyles();

  assert.ok(
    styles.includes(
      [
        '.expanding-panel-surface[data-panel-mode="live-transcript"]:not(.expanding-panel-surface-open) {',
        "  clip-path: inset(calc(100% - 52px) 0 0 calc(100% - 108px) round 24px);",
        "  opacity: 0;",
        "  transform: translate(4px, 4px);",
        "}",
      ].join("\n")
    ),
    "expected Live Transcript's right-origin closed geometry to be preserved verbatim, scoped to its own mode"
  );
  assert.ok(
    styles.includes(
      [
        '.expanding-panel-surface[data-panel-mode="live-transcript"].expanding-panel-anchor-bottom-left:not(.expanding-panel-surface-open) {',
        "  clip-path: inset(calc(100% - 52px) calc(100% - 108px) 0 0 round 24px);",
        "  transform: translate(-4px, 4px);",
        "}",
      ].join("\n")
    ),
    "expected Live Transcript's left-origin closed geometry to be preserved verbatim, scoped to its own mode"
  );
});

// Finding 1 (review 2026-09-08): before the rescoping above, the at-rest
// state (no data-panel-mode) and Live Transcript's closed state were the
// SAME declarations (both just the shared base rule), so mounting LT
// changed no computed value and started no transition. Now the rest state
// is the pill's 40px circle at opacity 1, so mounting LT DOES change clip-
// path/opacity/transform — starting an unwanted transition FROM the circle
// TOWARD the corner-box, which useLiveTranscriptPanel.js's mount-then-one-
// rAF-later-open timing (setMounted(true), then requestAnimationFrame(() =>
// setOpen(true))) then retargets mid-flight the instant -open lands, so the
// real entrance plays from wherever that retarget caught it — NOT from a
// clean 52/108/opacity-0 — breaking the ground-truth entrance. The fix
// gates transition off for exactly that one pre-open frame, using
// entrancePhase="encapsulate" (set in the SAME commit as mounted=true) to
// tell it apart from CLOSING, which reaches the identical mode=live-
// transcript+not-open combination but with entrancePhase="idle" and must
// keep animating.
test("Live Transcript's fresh-mount frame is tagged apart from its closing frame — the only signal that can gate one without silencing the other", async () => {
  const freshMount = await renderVoiceModePanelCore({
    mode: "live-transcript",
    open: false,
    entrancePhase: "encapsulate",
    horizontalDirection: "right",
  });
  const closing = await renderVoiceModePanelCore({
    mode: "live-transcript",
    open: false,
    entrancePhase: "idle",
    horizontalDirection: "right",
  });
  const openedEntrance = await renderVoiceModePanelCore({
    mode: "live-transcript",
    open: true,
    entrancePhase: "encapsulate",
    horizontalDirection: "right",
  });

  assert.match(freshMount, /data-panel-mode="live-transcript"/);
  assert.match(freshMount, /data-panel-entrance-phase="encapsulate"/);
  assert.doesNotMatch(freshMount, /expanding-panel-surface-open/);

  // Closing renders the SAME mode+not-open combination — entrancePhase is
  // the ONLY difference available to tell it apart from a fresh mount.
  assert.match(closing, /data-panel-mode="live-transcript"/);
  assert.doesNotMatch(closing, /expanding-panel-surface-open/);
  assert.doesNotMatch(
    closing,
    /data-panel-entrance-phase="encapsulate"/,
    "closing must NOT carry the fresh-mount tag, or its own animated collapse would be silenced too"
  );

  // Once open, the gate must no longer apply even though entrancePhase
  // stays "encapsulate" for a while longer (the encapsulated visual stage) —
  // -open is present, so this is the real entrance transition, which must
  // be free to play.
  assert.match(openedEntrance, /expanding-panel-surface-open/);
  assert.match(openedEntrance, /data-panel-entrance-phase="encapsulate"/);
});

test("Assistant mode never carries Live Transcript's entrance-phase attribute", async () => {
  // Pass a truthy entrancePhase despite mode="assistant" (App.jsx never
  // actually does this — it gates entrancePhase to undefined itself for
  // non-Live-Transcript modes — but the component's OWN gate must not rely
  // on that alone: a null/undefined-only prop would make this assertion
  // pass whether or not the isLiveTranscript check exists at all, proven by
  // this exact mutation during review).
  const assistantFresh = await renderVoiceModePanelCore({
    mode: "assistant",
    open: false,
    entrancePhase: "encapsulate",
    horizontalDirection: "right",
  });
  const assistantOpen = await renderVoiceModePanelCore({
    mode: "assistant",
    open: true,
    entrancePhase: "encapsulate",
    horizontalDirection: "right",
  });

  assert.doesNotMatch(assistantFresh, /data-panel-entrance-phase/);
  assert.doesNotMatch(assistantOpen, /data-panel-entrance-phase/);
});

test("Live Transcript's fresh-mount frame disables its transition, so it snaps to the closed corner-box instead of animating there from the shared circle rest-state", async () => {
  const styles = readDictationStyles();

  const freshMountGate = [
    '.expanding-panel-surface[data-panel-mode="live-transcript"][data-panel-entrance-phase="encapsulate"]:not(.expanding-panel-surface-open) {',
    "  transition: none;",
    "}",
  ].join("\n");

  assert.ok(
    styles.includes(freshMountGate),
    "expected a rule disabling transition specifically for Live Transcript's fresh-mount, pre-open frame"
  );

  // Regression guard: the gate must be scoped to the "encapsulate" phase
  // specifically, not merely "mode=live-transcript, not open" — the latter
  // ALSO matches while CLOSING (open removed, mode still mounted for its
  // 320ms unmount delay), which must keep animating, not snap shut.
  assert.doesNotMatch(
    styles,
    /\.expanding-panel-surface\[data-panel-mode="live-transcript"\]:not\(\.expanding-panel-surface-open\)\s*\{\s*transition:\s*none/,
    "must not disable transition for the whole mode=live-transcript,not-open state — that would also silence the closing animation"
  );
});

test("the pill's travel between docks can be driven onto the morph spring by an ease variable", async () => {
  const styles = readDictationStyles();

  const pillPositionRule = [
    ".voice-pill-position {",
    "  transition:",
    "    left var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1)),",
    "    bottom var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1)),",
    "    transform var(--voice-pill-travel-duration, 320ms) var(--voice-pill-travel-ease, cubic-bezier(0.2, 0, 0, 1));",
    "  will-change: left, bottom, transform;",
    "}",
  ].join("\n");

  assert.ok(
    styles.includes(pillPositionRule),
    "expected .voice-pill-position's transition to accept a --voice-pill-travel-ease override, defaulting to the prior cubic-bezier when unset"
  );
});

test("the pill's travel collapses to near-instant under reduced motion, without flattening its own opacity fade", async () => {
  const dictationPanelCss = readDictationPanelCss();

  // .expanding-panel-surface's own pre-existing, bare `transition-duration:
  // 1ms;` rule (unchanged by this task) already collapses its clip-path/
  // opacity/transform uniformly for the base (non-Live-Transcript) case, and
  // is correctly beaten by Live Transcript's own MORE SPECIFIC transition
  // rule when data-panel-mode="live-transcript" (specificity (0,2,0) beats
  // this rule's (0,1,0) even though this rule comes later in the file) — so
  // only .voice-pill-position genuinely needs a NEW override here.
  const pillTravelOverride = [
    "  .voice-pill-position {",
    "    transition:",
    "      left 1ms,",
    "      bottom 1ms,",
    "      transform 1ms;",
    "  }",
  ].join("\n");

  assert.ok(
    dictationPanelCss.includes(pillTravelOverride),
    "expected the pill's left/bottom/transform travel to collapse to 1ms under reduced motion"
  );

  // Regression guard (Finding 4, review 2026-09-08): a bare, un-named
  // `transition-duration: 1ms !important` on .voice-pill-position ALSO
  // flattened its separate Tailwind-driven opacity fade
  // (`transition-opacity duration-150` in the element's className) to 1ms,
  // because `!important` beats a non-important declaration regardless of
  // which cascade layer contributed it (Tailwind's utilities live in
  // `@layer utilities`; this file is unlayered) — contradicting index.css's
  // policy that opacity keeps its normal speed under reduced motion. Naming
  // exactly left/bottom/transform, and never `!important`, is what keeps
  // this rule from reaching opacity again.
  assert.doesNotMatch(
    dictationPanelCss,
    /\.voice-pill-position(\s*,\s*\.[\w-]+)?\s*\{\s*transition-duration:\s*1ms\s*!important/,
    "must not reintroduce a blanket !important transition-duration on .voice-pill-position"
  );

  // Confirm the override actually lives inside dictation-panel.css's OWN
  // reduced-motion media query (see readDictationPanelCss's comment for why
  // this must NOT be checked against the index.css-prefixed concatenation).
  const reducedMotionBlock = extractMediaBlock(
    dictationPanelCss,
    "@media (prefers-reduced-motion: reduce)"
  );
  assert.ok(
    reducedMotionBlock,
    "expected dictation-panel.css to have its own reduced-motion media block"
  );
  assert.ok(
    reducedMotionBlock.includes(pillTravelOverride),
    "expected the pill-travel override to live inside dictation-panel.css's OWN reduced-motion media query"
  );
});

test("the waveform pill keeps the normal compact logo footprint", async () => {
  const idle = await renderPill("idle", false);
  const recording = await renderPill("recording", true);
  const liveTranscript = await renderPill("recording", true, "right", {
    variant: "panel",
    integratedWithPanel: true,
  });

  for (const markup of [idle, recording, liveTranscript]) {
    assert.match(markup, /<svg width="22" height="22"/);
  }
});

test("an interactive voice pill is keyboard focusable", async () => {
  const interactive = await renderPill("recording", true, "right", {
    role: "button",
    tabIndex: 0,
  });

  assert.match(interactive, /role="button"/);
  assert.match(interactive, /tabindex="0"/);
});

test("the waveform uses foreground contrast, rounded caps, and a pronounced height range", async () => {
  const recording = await renderPill("recording", true);
  const { WAVEFORM_BAR_MIN_PX, WAVEFORM_BAR_MAX_PX, resolveWaveformBarHeight } =
    await import("../../src/components/dictation/waveformMath.ts");

  assert.match(recording, /relative shrink-0 overflow-hidden text-foreground/);
  assert.equal(
    (recording.match(/w-0\.5 rounded-full bg-current/g) || []).length,
    await totalWaveBars()
  );
  assert.equal(WAVEFORM_BAR_MIN_PX, 4);
  assert.equal(WAVEFORM_BAR_MAX_PX, 22);
  assert.equal(resolveWaveformBarHeight(0), WAVEFORM_BAR_MIN_PX);
  assert.equal(resolveWaveformBarHeight(1), WAVEFORM_BAR_MAX_PX);
  assert.ok(resolveWaveformBarHeight(0.15) > 20);
});

test("Live Transcript hands visual border ownership to the shared panel", async () => {
  const integrated = await renderPill("recording", true, "right", {
    variant: "panel",
    integratedWithPanel: true,
  });
  const standalone = await renderPill("recording", true);

  assert.match(integrated, /voice-pill-control/);
  assert.match(integrated, /data-integrated-with-panel="true"/);
  assert.doesNotMatch(standalone, /data-integrated-with-panel/);
});

test("Agent Mode uses the supplied mark, a purple perimeter glow, and a neutral waveform", async () => {
  const agentRecording = await renderPill("recording", true, "right", {
    agentMode: true,
  });
  const normalRecording = await renderPill("recording", true);
  const { AGENT_MODE_PATH } = await import("../../src/components/dictation/voiceIdentityMorph.ts");
  const styles = readDictationStyles();

  assert.match(AGENT_MODE_PATH, /^M6\.14226 /);
  assert.match(styles, /--color-agent-brand:/);
  assert.doesNotMatch(styles, /\.voice-pill-control\[data-agent-mode="true"\]\s*\{/);
  // The agent glow is the same Signal treatment re-palettes to the agent's
  // purple around the brand color.
  assert.match(styles, /\.processing-signal-glow\[data-agent="true"\]\s*\{/);
  assert.match(styles, /--signal-core: #8787ff/);
  assert.doesNotMatch(styles, /agent-waveform-background|agent-waveform-highlight/);
  // Listening stays glow-free; the purple Signal glow is reserved for the
  // post-recording thinking state so "hearing you" and "working" read apart.
  assert.match(agentRecording, /class="processing-signal-glow" data-agent="true"/);
  assert.doesNotMatch(agentRecording, /data-active/);
  assert.match(agentRecording, /data-agent-mode="true"/);
  assert.match(agentRecording, /voice-identity-final-agent/);
  assert.ok(agentRecording.includes(`d="${AGENT_MODE_PATH}"`));
  assert.doesNotMatch(agentRecording, /agent-waveform-background|text-agent-brand/);
  assert.equal(
    (agentRecording.match(/w-0\.5 rounded-full bg-current/g) || []).length,
    await totalWaveBars()
  );
  assert.doesNotMatch(normalRecording, /agent-waveform-background/);
});

test("Agent thinking keeps the purple glow on the same persistent pill root", async () => {
  const agentThinking = await renderPill("thinking", false, "right", {
    agentMode: true,
  });

  assert.match(
    agentThinking,
    /class="processing-signal-glow" data-active="true" data-agent="true"/
  );
  assert.match(agentThinking, /<div [^>]*data-agent-mode="true"/);
  assert.match(agentThinking, /data-agent-beam-active="true"/);
});

test("the stable identity box stages the sound-bars into the Agent mark", async () => {
  const idle = await renderPill("idle", false);
  const agentThinking = await renderPill("thinking", false, "right", {
    agentMode: true,
  });

  assert.match(idle, /data-agent-mode="false"/);
  assert.match(idle, /voice-identity-morph-shell/);
  assert.match(idle, /voice-identity-morph-bar-left/);
  assert.match(idle, /voice-identity-morph-bar-center/);
  assert.match(idle, /voice-identity-morph-bar-right/);
  assert.match(agentThinking, /data-agent-mode="true"/);
  assert.match(agentThinking, /voice-identity-final-agent/);
});

test("the voice identity performs an actual SVG geometry morph", async () => {
  const { resolveVoiceIdentityMorphPaths } =
    await import("../../src/components/dictation/voiceIdentityMorph.ts");
  const listening = resolveVoiceIdentityMorphPaths(0);
  const midpoint = resolveVoiceIdentityMorphPaths(0.5);
  const agent = resolveVoiceIdentityMorphPaths(1);

  assert.notEqual(listening.shell, midpoint.shell);
  assert.notEqual(midpoint.shell, agent.shell);
  assert.notEqual(listening.centerBar, midpoint.centerBar);
  assert.notEqual(midpoint.centerBar, agent.centerBar);
  assert.equal(listening.agentOpacity, 0);
  assert.ok(midpoint.sparkOpacity > 0);
  assert.equal(agent.agentOpacity, 1);
  assert.equal(agent.constructionOpacity, 0);
});
