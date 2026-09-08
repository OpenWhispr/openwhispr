// Covers the CSS half of Task 5 (per-word rise): the normal rule must
// reference Task 1's pinned easing/duration variables (not hardcoded
// numbers reachable only by coincidence), the keyframe must only touch
// transform/opacity, and the reduced-motion override must land in
// dictation-panel.css's OWN media block and actually be able to reach the
// element — verified from CSS text via cascade rules, not a live browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = path.resolve(__dirname, "../..");
const readCss = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");

// Strip comments first: a comment that merely NAMES a selector (explaining
// why it has no rule, e.g. dictation-panel.css's own precedent for
// .voice-pill-position) would otherwise false-positive a naive text search.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// Extract one top-level `@media (...) { ... }` OR `@keyframes ... { ... }`
// block by matching braces, not the next "}" — both can contain nested
// rule/stop blocks, each with its own closing brace. Mirrors the helper
// proven in voicePillStructure.test.js (generalized here beyond @media,
// since @keyframes from{}/to{} stops have exactly the same nesting trap).
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
// valid when the body itself has no nested braces (true for every plain
// rule this file checks; @keyframes needs extractBalancedBlock instead).
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

test("the word-rise rule animates on Task 1's pinned word easing and duration variables, with a fallback matching MOTION_TIMING.wordMs", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));

  // Scoped to dictation-panel.css's OWN reduced-motion block only — see the
  // comment on readDictationPanelCss() in voicePillStructure.test.js for why
  // a concatenation with index.css (which has its own earlier, unrelated
  // reduced-motion block) would make an indexOf-anchored search vacuous.
  const reducedMotionBlock = extractBalancedBlock(css, "@media (prefers-reduced-motion: reduce)");
  assert.ok(reducedMotionBlock, "expected dictation-panel.css to have its own reduced-motion block");

  // The NORMAL rule lives before that block starts.
  const normalCss = css.slice(0, css.indexOf(reducedMotionBlock));
  const rule = extractRule(normalCss, '.assistant-word[data-rise="true"] {');
  assert.ok(rule, "expected a normal (non-reduced-motion) rule for .assistant-word[data-rise=\"true\"]");

  // Assert the EASING and TIMING variables themselves — not just that some
  // animation is present. A Task 2 review reverted an entire spring and the
  // suite stayed green because only durations were pinned; this also checks
  // the custom-property name for the easing.
  assert.match(rule, /animation:\s*assistant-word-rise\s+var\(--motion-word-ms,\s*[\d.]+ms\)\s+var\(--motion-word-ease,/);

  // The var() fallback must track MOTION_TIMING.wordMs, not a retyped
  // literal that can silently drift from the real constant.
  const fallbackMatch = rule.match(/var\(--motion-word-ms,\s*([\d.]+)ms\)/);
  assert.ok(fallbackMatch, "expected a --motion-word-ms fallback duration in the animation shorthand");
  assert.equal(Number(fallbackMatch[1]), MOTION_TIMING.wordMs);

  // The real easing is supplied at runtime by the --motion-word-ease custom
  // property (installed once on .dictation-window via motionCssVariables()
  // — Task 5 must not add a second installation, so it never appears as a
  // literal in this file); the var() fallback is deliberately a plain
  // cubic-bezier approximation, matching the SAME sitewide convention every
  // other spring-driven rule in this file uses (e.g. --motion-morph-ease
  // right above), not the full sampled linear() curve. What must be pinned
  // here is the VARIABLE NAME itself — a Task-2-style regression that
  // silently reused the wrong spring (e.g. --motion-morph-ease) would still
  // "animate something" and could slip past a looser check.
  const morphEaseFallback = css.match(/var\(--motion-morph-ease,\s*([^)]+)\)/);
  assert.ok(morphEaseFallback, "expected a sibling --motion-morph-ease rule to compare the convention against");
  const wordEaseFallback = rule.match(/var\(--motion-word-ease,\s*([^)]+)\)/);
  assert.ok(wordEaseFallback, "expected a --motion-word-ease fallback in the animation shorthand");
  assert.equal(
    wordEaseFallback[1],
    morphEaseFallback[1],
    "the word-rise rule's --motion-word-ease fallback should follow the same plain-cubic-bezier convention as this file's other spring-driven rules"
  );

  assert.match(rule, /display:\s*inline-block/);
});

test("the word-rise keyframe animates only transform and opacity", async () => {
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));
  // @keyframes nests a from{}/to{}/percentage block, so this needs the
  // balanced extractor, not the flat-only extractRule (which now refuses to
  // silently truncate at that block's own closing brace).
  const block = extractBalancedBlock(css, "@keyframes assistant-word-rise {");
  assert.ok(block, "expected an assistant-word-rise keyframe");

  // Collect every CSS property name declared anywhere in the keyframe body
  // (across from/to/percentage stops) and assert the set is exactly the
  // allowed transform/opacity/clip-path list this task is scoped to. Scanning
  // the whole balanced block (not just an inner stop) is safe here: neither
  // "@keyframes assistant-word-rise" nor a stop selector like "from" is
  // itself followed by a colon, so the property regex can't mistake them.
  const properties = new Set(
    Array.from(block.matchAll(/([a-z-]+)\s*:/g), (m) => m[1])
  );
  assert.deepEqual([...properties].sort(), ["opacity", "transform"]);
});

test("reduced motion disables the word-rise animation inside dictation-panel.css's own media block, and index.css's blanket rule cannot fight it", async () => {
  const dictationPanelCss = stripCssComments(readCss("src/styles/dictation-panel.css"));
  const reducedMotionBlock = extractBalancedBlock(
    dictationPanelCss,
    "@media (prefers-reduced-motion: reduce)"
  );
  assert.ok(reducedMotionBlock);

  const overrideRule = extractRule(reducedMotionBlock, '.assistant-word[data-rise="true"] {');
  assert.ok(overrideRule, "expected a reduced-motion override for .assistant-word[data-rise=\"true\"]");
  assert.match(overrideRule.trim(), /^animation:\s*none;?$/);

  // Cascade-safety regression guard, verified from CSS text (not a live
  // browser — see the task's own warning about this exact trap): `animation:
  // none` works here ONLY because it resets animation-NAME (which nothing
  // else contests). index.css's blanket `*, *::before, *::after` reduced-motion
  // rule sets animation-duration/animation-iteration-count as !important, but
  // must NOT also set animation-name (or the bare `animation` shorthand,
  // which would) — if it ever does, an !important animation-name there would
  // beat this non-important override regardless of specificity, and the
  // by-the-book fix (a transition-property trap for `transition`-based
  // rules) does not apply here since this is `animation`, not `transition`.
  const indexCss = stripCssComments(readCss("src/index.css"));
  const universalReducedMotionBlock = extractBalancedBlock(
    indexCss,
    "@media (prefers-reduced-motion: reduce)"
  );
  assert.ok(universalReducedMotionBlock);
  const universalRule = extractRule(universalReducedMotionBlock, "*,\n  *::before,\n  *::after {");
  assert.ok(
    universalRule,
    "expected index.css's universal reduced-motion rule at its known selector text"
  );
  assert.doesNotMatch(
    universalRule,
    /(^|[^-])animation-name\s*:/,
    "index.css's universal rule must not set animation-name, or it would out-cascade (via !important) this file's `animation: none` override regardless of selector specificity"
  );
  assert.doesNotMatch(
    universalRule,
    /(^|[^-])animation\s*:/,
    "index.css's universal rule must not set the bare `animation` shorthand either, for the same reason"
  );
});
