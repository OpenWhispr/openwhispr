// Covers the CSS half of Task 7 (panel close -> one spring to the pill's
// circle; the companion fades with it): the assistant shell's direct
// children must fade AND retreat on Task 1's pinned close-fade variable (not
// a hardcoded guess), the closing state must actually apply that retreat,
// reduced motion must shorten the fade instead of silently inheriting a
// mismatched duration via CSS's transition-property/duration positional
// cycling (the same trap .voice-pill-position hit, named in the task's own
// constraints), and the companion pill's own fade must do the same. Verified
// from CSS text via cascade rules, not a live browser — see each test's own
// comment for what that does and does not prove.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = path.resolve(__dirname, "../..");
const readCss = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");

// Strip comments first: a comment that merely NAMES a selector would
// otherwise false-positive a naive text search. Mirrors
// streamingReplyMotionCss.test.js's own helper.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Extract one top-level `@media (...) { ... }` block by matching braces, not
// the next "}" — the block contains nested rules, each with its own closing
// brace. Mirrors the helper proven in voicePillStructure.test.js /
// streamingReplyMotionCss.test.js.
function extractBalancedBlock(source, selectorText) {
  const start = source.indexOf(selectorText);
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
}

// Extract one FLAT `selector { ... }` rule's own declaration body — only
// valid when the body itself has no nested braces.
function extractRule(source, selectorText) {
  const start = source.indexOf(selectorText);
  if (start < 0) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return null;
  const closeBrace = source.indexOf("}", openBrace);
  if (closeBrace < 0) return null;
  assert.ok(
    !source.slice(openBrace + 1, closeBrace).includes("{"),
    `extractRule used on a block with nested braces (needed extractBalancedBlock instead): ${selectorText}`
  );
  return source.slice(openBrace + 1, closeBrace);
}

test("the assistant shell's direct children fade and retreat on Task 1's pinned close-fade variable, with a fallback matching MOTION_TIMING.closeFadeMs", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));

  const reducedMotionBlock = extractBalancedBlock(css, "@media (prefers-reduced-motion: reduce)");
  assert.ok(
    reducedMotionBlock,
    "expected dictation-panel.css to have its own reduced-motion block"
  );
  const normalCss = css.slice(0, css.indexOf(reducedMotionBlock));

  const rule = extractRule(
    normalCss,
    '.expanding-panel-surface[data-panel-mode="assistant"] > * {'
  );
  assert.ok(
    rule,
    'expected a normal rule for .expanding-panel-surface[data-panel-mode="assistant"] > *'
  );

  // Assert the EASING and the duration VARIABLE, not just that opacity
  // transitions at all.
  assert.match(rule, /opacity\s+var\(--motion-close-fade-ms,\s*[\d.]+ms\)\s+ease-out/);
  assert.match(rule, /transform\s+160ms\s+ease-out/);

  // The var() fallback must track MOTION_TIMING.closeFadeMs, not a retyped
  // literal that can silently drift from the real constant.
  const fallbackMatch = rule.match(/var\(--motion-close-fade-ms,\s*([\d.]+)ms\)/);
  assert.ok(fallbackMatch, "expected a --motion-close-fade-ms fallback duration");
  assert.equal(Number(fallbackMatch[1]), MOTION_TIMING.closeFadeMs);

  const closingRule = extractRule(
    normalCss,
    '.expanding-panel-surface[data-panel-mode="assistant"][data-panel-closing="true"] > * {'
  );
  assert.ok(closingRule, "expected the data-panel-closing=true rule for the same children");
  assert.match(closingRule, /pointer-events:\s*none/);
  assert.match(closingRule, /opacity:\s*0/);
  // The 4px drop: proves this is a real retreat, not opacity-only.
  assert.match(closingRule, /transform:\s*translateY\(4px\)/);
});

test("reduced motion shortens the assistant children's close fade instead of inheriting a duration positionally", async () => {
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));
  const reducedMotionBlock = extractBalancedBlock(css, "@media (prefers-reduced-motion: reduce)");
  assert.ok(reducedMotionBlock);

  // index.css's blanket reduced-motion rule replaces transition-property
  // with a fixed list (opacity survives, transform does not) but never
  // touches transition-duration — so without an explicit override here, the
  // surviving opacity transition would keep whatever duration this file's
  // own multi-value list assigns it BY POSITION against the forced property
  // list, not by name. A single value here (not a list) broadcasts to every
  // forced property instead, avoiding that mismatch — same convention as
  // .assistant-copy-label-layer's own reduced-motion override in this file.
  const override = extractRule(
    reducedMotionBlock,
    '.expanding-panel-surface[data-panel-mode="assistant"] > * {'
  );
  assert.ok(override, "expected a reduced-motion override for the assistant children");
  assert.match(override.trim(), /^transition-duration:\s*1ms\s*!important;?$/);
});

test("the companion pill fades on Task 1's pinned companion-fade variable, with a fallback matching MOTION_TIMING.companionFadeMs", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const css = stripCssComments(readCss("src/styles/agent-dictation-pill.css"));

  const rule = extractRule(css, ".agent-dictation-pill-window {");
  assert.ok(rule, "expected a normal opacity-transition rule for .agent-dictation-pill-window");
  assert.match(rule, /opacity\s+var\(--motion-companion-fade-ms,\s*[\d.]+ms\)\s+ease-out/);

  const fallbackMatch = rule.match(/var\(--motion-companion-fade-ms,\s*([\d.]+)ms\)/);
  assert.ok(fallbackMatch, "expected a --motion-companion-fade-ms fallback duration");
  assert.equal(Number(fallbackMatch[1]), MOTION_TIMING.companionFadeMs);

  const exitingRule = extractRule(css, '.agent-dictation-pill-window[data-exiting="true"] {');
  assert.ok(exitingRule, "expected a data-exiting=true rule");
  assert.match(exitingRule, /opacity:\s*0/);
  assert.match(exitingRule, /pointer-events:\s*none/);
});

test("reduced motion shortens the companion pill's own fade", async () => {
  const css = stripCssComments(readCss("src/styles/agent-dictation-pill.css"));
  const reducedMotionBlock = extractBalancedBlock(css, "@media (prefers-reduced-motion: reduce)");
  assert.ok(reducedMotionBlock, "expected agent-dictation-pill.css to have a reduced-motion block");

  const override = extractRule(reducedMotionBlock, ".agent-dictation-pill-window {");
  assert.ok(override, "expected a reduced-motion override for .agent-dictation-pill-window");
  assert.match(override.trim(), /^transition-duration:\s*1ms\s*!important;?$/);
});
