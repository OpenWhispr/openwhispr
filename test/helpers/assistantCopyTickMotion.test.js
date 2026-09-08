const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderAssistantPanel } = require("./renderAssistantPanel");

// Covers what the hook's own unit test (test/hooks/useCrossfadedLabel.test.js)
// structurally cannot: whether AssistantPanel's real JSX actually wires
// copiedLabel's booleans into the right CSS strings. A hook test proves the
// state machine; only rendering the real component proves the wiring, and
// "just check the Check icon appears" wouldn't catch a reverted easing or
// duration the way Task 2's spring regression slipped through — this checks
// the literal animation/transition strings instead.
const sourceRoot = path.resolve(__dirname, "../..");
const loadMotionTiming = async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  return MOTION_TIMING;
};

// Extracts one top-level `@media (prefers-reduced-motion: reduce) { ... }`
// block by matching braces (a media query holds many nested rule blocks,
// each with its own closing brace, so "the next }" is not enough) —
// mirrors voicePillStructure.test.js's extractMediaBlock.
function extractReducedMotionBlock(css) {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start < 0) return null;
  const openBrace = css.indexOf("{", start);
  let depth = 1;
  let i = openBrace + 1;
  for (; i < css.length && depth > 0; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  return css.slice(start, i);
}

test("the copy tick pops the Check icon in on arrival and wraps the label for a crossfade, using the pinned duration (not a retyped literal)", async (t) => {
  const { copyCrossfadeMs } = await loadMotionTiming();
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
    copied: true,
  });

  assert.match(
    markup,
    /class="lucide lucide-check"[^>]*style="animation:tool-check-pop 300ms cubic-bezier\(0\.2, 0, 0, 1\) both"/,
    "the arriving Check icon must carry the reused tool-check-pop keyframe at its pinned easing and duration"
  );
  assert.match(
    markup,
    new RegExp(`class="assistant-copy-label[^"]*" style="opacity:1;transition:opacity ${copyCrossfadeMs}ms ease-out"`),
    "the label wrapper must be fully opaque and transition on MOTION_TIMING.copyCrossfadeMs, not a hardcoded number"
  );
  assert.match(markup, />Copied</);
  assert.doesNotMatch(markup, />C<\/kbd>/, "the shortcut hint must not show while the tick is showing");
});

test("the label fades toward transparent while showActive is still true — the tick has not yet swapped back to Copy", async (t) => {
  const { copyCrossfadeMs } = await loadMotionTiming();
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
    copiedLabel: { showActive: true, fading: true },
  });

  assert.match(
    markup,
    new RegExp(`class="assistant-copy-label[^"]*" style="opacity:0;transition:opacity ${copyCrossfadeMs}ms ease-out"`),
    "fading must drive opacity to 0 while keeping the same pinned transition duration"
  );
  assert.match(
    markup,
    /class="lucide lucide-check"/,
    "showActive is still true mid-fade, so the Check icon (not Copy) must still be the one rendered"
  );
});

test("the resting (never-copied) label is fully opaque and still carries the pinned crossfade transition", async (t) => {
  const { copyCrossfadeMs } = await loadMotionTiming();
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
  });

  assert.match(
    markup,
    new RegExp(`class="assistant-copy-label[^"]*" style="opacity:1;transition:opacity ${copyCrossfadeMs}ms ease-out"`)
  );
  assert.match(markup, /class="lucide lucide-copy"/);
  assert.match(markup, />C<\/kbd>/);
});

// Source-text checks only, same limits as voicePillStructure.test.js's own
// reduced-motion checks (see its Fix round 2/3 comments): this proves the
// RULE exists, targets the right selector, and marks the right property
// !important. It does not and cannot prove the real computed transition
// duration a browser would apply under reduced motion — that needs an
// actual browser (Vite + Tailwind build, headless Chrome,
// --force-prefers-reduced-motion, getComputedStyle), which this harness
// does not have.
test("dictation-panel.css's own reduced-motion block forces the copy label's crossfade duration to 1ms", async () => {
  const dictationPanelCss = fs.readFileSync(
    path.join(sourceRoot, "src/styles/dictation-panel.css"),
    "utf8"
  );

  const reducedMotionBlock = extractReducedMotionBlock(dictationPanelCss);
  assert.ok(reducedMotionBlock, "expected dictation-panel.css to have its own reduced-motion media block");

  assert.match(
    reducedMotionBlock,
    /\.assistant-copy-label\s*\{\s*transition-duration:\s*1ms\s*!important;\s*\}/,
    "expected a !important transition-duration: 1ms override for .assistant-copy-label inside dictation-panel.css's own reduced-motion block — required because the crossfade duration is set via an inline React style, which only an !important stylesheet rule can override"
  );
});

// The pop-in's OWN reduced-motion story is the mirror image: no new rule is
// needed because index.css's blanket rule already forces animation-duration
// (not just transition-property) to near-zero for every element, inline
// styles included, since !important beats a non-important inline value
// regardless of selector. This pins that the blanket rule still says what
// the CSS wiring above relies on, so a future edit to it doesn't silently
// leave the pop-in animating at full speed under reduced motion with no
// test noticing.
test("index.css's blanket reduced-motion rule still forces every element's animation-duration — what lets the pop-in skip its own override", async () => {
  const indexCss = fs.readFileSync(path.join(sourceRoot, "src/index.css"), "utf8");
  const block = extractReducedMotionBlock(indexCss);
  assert.ok(block, "expected index.css to have a reduced-motion media block");

  assert.match(block, /\*,\s*\n\s*\*::before,\s*\n\s*\*::after\s*\{/, "expected the universal selector");
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/);
});
