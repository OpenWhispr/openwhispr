const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderAssistantPanel } = require("./renderAssistantPanel");

// Covers what the hook's own unit test (test/hooks/useCrossfadedLabel.test.js)
// structurally cannot: whether AssistantPanel's real JSX actually wires
// copiedLabel's booleans into the right CSS strings, and — after fix round 1 —
// whether the revert is a REAL crossfade (both labels present, opposite
// opacities, one shared 320ms window) rather than a fade-out-then-fade-in
// through a blank frame. A hook test proves the state machine; only
// rendering the real component proves the wiring.
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

// The two labels are siblings, each marked `data-copy-label-layer="active"
// | "inactive"`. Isolating one layer's own opening tag (for its class/style/
// aria-hidden) and its own inner content (for which icon/text it holds) by
// string slicing — not one long regex — so attribute ORDER in the rendered
// style string can never make an otherwise-correct assertion flaky.
function layerOpenTag(markup, layer) {
  const markerIndex = markup.indexOf(`data-copy-label-layer="${layer}"`);
  assert.ok(markerIndex >= 0, `expected a data-copy-label-layer="${layer}" span in the markup`);
  const tagStart = markup.lastIndexOf("<span", markerIndex);
  const tagEnd = markup.indexOf(">", markerIndex);
  return markup.slice(tagStart, tagEnd + 1);
}

function layerContent(markup, layer) {
  const otherLayer = layer === "active" ? "inactive" : "active";
  const markerIndex = markup.indexOf(`data-copy-label-layer="${layer}"`);
  const contentStart = markup.indexOf(">", markerIndex) + 1;
  const otherMarkerIndex = markup.indexOf(`data-copy-label-layer="${otherLayer}"`);
  const contentEnd =
    otherMarkerIndex > markerIndex ? markup.lastIndexOf("<span", otherMarkerIndex) : markup.length;
  return markup.slice(contentStart, contentEnd);
}

test("arrival: the active (Check/Copied) layer is fully opaque and untransitioned; the inactive (Copy) layer sits hidden underneath, both sharing the same stack cell", async (t) => {
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
    copied: true,
  });

  // justify-items-center pins the fix for the constant-width button leaving
  // the shorter "Copied" layer's content stranded against the left edge of
  // the wider grid cell: it stops each stacked layer from stretching to
  // fill the cell, so its own content centers instead. This only proves the
  // class reaches the rendered markup — renderToStaticMarkup does no layout,
  // so whether the content actually paints centered is a computed-layout
  // claim a real browser would have to settle.
  assert.match(markup, /class="assistant-copy-label inline-grid items-center justify-items-center"/);

  const active = layerOpenTag(markup, "active");
  assert.match(active, /opacity:1/);
  assert.match(active, /transition:none/, "arrival must not animate the label — only the pop plays");
  assert.match(active, /grid-area:1 \/ 1/);
  assert.doesNotMatch(active, /aria-hidden/, "the visible layer must not be hidden from assistive tech");

  const activeContent = layerContent(markup, "active");
  assert.match(
    activeContent,
    /class="lucide lucide-check"[^>]*style="animation:tool-check-pop 300ms cubic-bezier\(0\.2, 0, 0, 1\) both"/,
    "the arriving Check icon must carry the reused tool-check-pop keyframe at its pinned easing and duration"
  );
  assert.match(activeContent, />Copied</);

  const inactive = layerOpenTag(markup, "inactive");
  assert.match(inactive, /opacity:0/);
  assert.match(inactive, /transition:none/);
  assert.match(inactive, /grid-area:1 \/ 1/, "both layers must share one grid cell so the wrapper sizes to fit both, never jumping");
  assert.match(inactive, /aria-hidden="true"/, "the label underneath must not be read while the tick is showing");
});

test("revert: BOTH labels are present and opposite-fading over the SAME single window — not a fade to blank followed by a second fade-in", async (t) => {
  const { copyCrossfadeMs } = await loadMotionTiming();
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
    copiedLabel: { showActive: true, fading: true },
  });

  const active = layerOpenTag(markup, "active");
  const inactive = layerOpenTag(markup, "inactive");
  const activeTransition = `opacity ${copyCrossfadeMs}ms ease-out`;

  assert.match(active, /opacity:0/, "the outgoing Check/Copied label fades OUT");
  assert.match(inactive, /opacity:1/, "the incoming Copy label fades IN — simultaneously, not afterward");
  assert.ok(
    active.includes(`transition:${activeTransition}`) && inactive.includes(`transition:${activeTransition}`),
    "both layers must share the identical MOTION_TIMING.copyCrossfadeMs-derived transition string — one 320ms window, not two 320ms windows stitched end to end"
  );

  // The defect fix round 1 found: at t=6333 the OLD single-span design
  // unmounted "Copied" and mounted "Copy to clipboard" at opacity 0 — an
  // empty button for one frame, then a SECOND 320ms fade-in (640ms total).
  // What is verifiable from markup alone: both labels' text/icon markers
  // are simultaneously present in this one render — there is no render of
  // this component, at any point in the revert, where neither label's
  // content exists in the DOM. That rules out the "empty button" anatomy
  // structurally. It does NOT by itself prove the two opacities are
  // painted as a single overlapping crossfade rather than, say, both
  // stuck at some intermediate frame — that is a computed-layout/paint
  // claim only a real browser can settle; see Task 11's frame capture.
  const activeContent = layerContent(markup, "active");
  const inactiveContent = layerContent(markup, "inactive");
  assert.match(activeContent, /class="lucide lucide-check"/);
  assert.match(activeContent, />Copied</);
  assert.match(inactiveContent, /class="lucide lucide-copy"/);
  assert.match(inactiveContent, />Copy to clipboard</);

  assert.match(active, /aria-hidden="true"/, "the layer fading toward 0 must stop being announced");
  assert.doesNotMatch(inactive, /aria-hidden/, "the layer fading toward 1 must become the announced content");
});

test("resting (never copied): only the inactive (Copy) layer has content; the active layer is empty as well as hidden", async (t) => {
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
  });

  const active = layerOpenTag(markup, "active");
  assert.match(active, /opacity:0/);
  assert.match(active, /transition:none/);
  assert.match(active, /aria-hidden="true"/);
  const activeContent = layerContent(markup, "active");
  assert.doesNotMatch(activeContent, /lucide-check/, "no Check icon should ever mount before the first copy");
  assert.doesNotMatch(activeContent, />Copied</);

  const inactive = layerOpenTag(markup, "inactive");
  assert.match(inactive, /opacity:1/);
  assert.doesNotMatch(inactive, /aria-hidden/);
  const inactiveContent = layerContent(markup, "inactive");
  assert.match(inactiveContent, /class="lucide lucide-copy"/);
  assert.match(inactiveContent, />Copy to clipboard</);
  assert.match(inactiveContent, />C<\/kbd>/);
});

// Source-text checks only, same limits as voicePillStructure.test.js's own
// reduced-motion checks (see its Fix round 2/3 comments): this proves the
// RULE exists, targets the right selector, and marks the right property
// !important. It does not and cannot prove the real computed transition
// duration a browser would apply under reduced motion — that needs an
// actual browser (Vite + Tailwind build, headless Chrome,
// --force-prefers-reduced-motion, getComputedStyle), which this harness
// does not have.
test("dictation-panel.css's own reduced-motion block forces BOTH crossfade layers' duration to 1ms", async () => {
  const dictationPanelCss = fs.readFileSync(
    path.join(sourceRoot, "src/styles/dictation-panel.css"),
    "utf8"
  );

  const reducedMotionBlock = extractReducedMotionBlock(dictationPanelCss);
  assert.ok(reducedMotionBlock, "expected dictation-panel.css to have its own reduced-motion media block");

  assert.match(
    reducedMotionBlock,
    /\.assistant-copy-label-layer\s*\{\s*transition-duration:\s*1ms\s*!important;\s*\}/,
    "expected a !important transition-duration: 1ms override for .assistant-copy-label-layer (the class BOTH layers share) inside dictation-panel.css's own reduced-motion block — required because the crossfade duration is set via an inline React style, which only an !important stylesheet rule can override"
  );
});

// Finding 2 (fix round 1): under reduced motion the OLD single-span design
// held the button BLANK for ~319ms — the CSS shortened the fade to opacity 0
// almost instantly, but the JS timer still took the full 320ms to swap the
// DOM content back in. The two-layer redesign changes the mechanism enough
// that this should no longer be possible: because the reduced-motion rule
// above targets the class BOTH layers share, and because both layers are
// ALWAYS mounted (never swapped in/out of the DOM — only their own opacity
// changes), shortening the transition duration to 1ms shortens BOTH the
// outgoing fade AND the incoming fade to 1ms, together — there is no
// "swap the DOM content" step gated behind the JS timer for the user to
// wait through, only an opacity crossfade that happens to complete almost
// instantly. That chain of reasoning is what this test pins structurally
// (one shared class, one shared !important rule, two always-mounted
// layers). It does NOT independently re-measure the reduced-motion timeline
// in a browser — Task 11's frame capture is what would confirm the actual
// wall-clock gap (if any) is now ~0ms instead of ~319ms.
test("the reduced-motion override reaches the exact class name both crossfade layers render", async (t) => {
  const dictationPanelCss = fs.readFileSync(
    path.join(sourceRoot, "src/styles/dictation-panel.css"),
    "utf8"
  );
  const markup = await renderAssistantPanel(
    t,
    [{ id: "a", role: "assistant", content: "hi", isStreaming: false }],
    { footerPhase: "actions", copiedLabel: { showActive: true, fading: true } }
  );
  const reducedMotionBlock = extractReducedMotionBlock(dictationPanelCss);
  const overrideMatch = reducedMotionBlock.match(/\.([a-zA-Z0-9-]+)\s*\{\s*transition-duration:\s*1ms\s*!important;/);
  assert.ok(overrideMatch, "expected to find the copy-label reduced-motion override's selector");
  const overriddenClass = overrideMatch[1];

  // An exact space-separated token check, not a substring/word-boundary
  // regex: "-" is a non-word character, so a `\b...\b` match would ALSO
  // fire on a class like "assistant-copy-label-layer-inactive-only" —
  // hyphens create a word boundary right where the wanted class name ends,
  // so that regex shape passed even when a layer's class was quietly
  // renamed out from under the CSS rule's selector (caught in bite-check:
  // renaming the inactive layer's class left this test green until the
  // check was rewritten to this token match).
  const classTokens = (markup, layer) => {
    const tag = layerOpenTag(markup, layer);
    const classMatch = tag.match(/class="([^"]*)"/);
    assert.ok(classMatch, `expected a class attribute on the ${layer} layer`);
    return classMatch[1].split(/\s+/);
  };
  assert.ok(
    classTokens(markup, "active").includes(overriddenClass),
    "the outgoing layer must carry the exact overridden class"
  );
  assert.ok(
    classTokens(markup, "inactive").includes(overriddenClass),
    "the incoming layer must carry the exact overridden class"
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

// Josh, 2026-09-08, on the rig: "I don't like the selected state once you
// press copy. I like the little tick jump, but the blue is a bit jarring."
//
// The copy button takes Button's `default` variant, whose pressed state is
// `active:bg-primary/85`. tailwind-merge only drops a variant class that the
// caller supplies a REPLACEMENT for, and the caller's overrides covered the
// base and hover backgrounds but not the pressed one — so full primary blue
// survived on :active alone and flashed, over the variant's own 200ms colour
// transition, on every copy. This asserts against the CLASS LIST THE MERGE
// ACTUALLY PRODUCED, which is the only place that outcome is visible: the
// source className and the variant definition each look correct on their own.
test("the copy button's pressed state is never the primary blue (Josh 2026-09-08)", async (t) => {
  const markup = await renderAssistantPanel(t, [{ id: "a", role: "assistant", content: "hi", isStreaming: false }], {
    footerPhase: "actions",
  });

  const labelAt = markup.indexOf("assistant-copy-label");
  assert.ok(labelAt > 0, "fixture-integrity check: the copy button must be rendered");
  const buttonAt = markup.lastIndexOf("<button", labelAt);
  const classMatch = /class="([^"]*)"/.exec(markup.slice(buttonAt, labelAt));
  assert.ok(classMatch, "fixture-integrity check: the copy button must carry a class attribute");
  const classes = classMatch[1].split(/\s+/);

  // Non-vacuity, and the whole reason this test exists: the variant really
  // does ship a primary-blue pressed state, so "no active:bg-primary on the
  // button" is a fact about the merge, not about a class nobody ever added.
  const buttonSource = fs.readFileSync(path.join(sourceRoot, "src/components/ui/button.tsx"), "utf8");
  assert.match(
    buttonSource,
    /active:bg-primary\//,
    "fixture-integrity check: Button's default variant must still declare a primary-blue pressed state, or this test proves nothing"
  );

  assert.ok(
    !classes.some((name) => name.startsWith("active:bg-primary")),
    `the copy button must not keep the variant's primary-blue pressed state (classes: ${classMatch[1]})`
  );
  // The override must actually be present, not merely absent-by-accident: a
  // pressed state with no background at all would also pass the check above
  // while leaving the button free to inherit a future variant's colour.
  assert.ok(
    classes.some((name) => name.startsWith("active:bg-")),
    `the copy button must declare its own pressed-state background (classes: ${classMatch[1]})`
  );
});
