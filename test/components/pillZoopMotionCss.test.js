// Covers the CSS half of Task 9 (hide "zoop" / show "unzoop"): the exit must
// scale the pill into its OWN centre on Task 1's pinned zoop spring and
// duration variables (not a hardcoded guess), the return must play the show
// spring, only transform/opacity may animate, the exit origin must not
// silently retune the Assistant footer's own enter/retreat animations, and
// reduced motion must shorten the transition instead of inheriting a
// mismatched duration through CSS's transition-property/duration positional
// cycling (the trap .voice-pill-position hit, named in this task's own
// constraints). Verified from CSS text via cascade rules, not a live browser —
// see each test's own comment for what that does and does not prove.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = path.resolve(__dirname, "../..");
const readCss = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");

// Strip comments first: a comment that merely NAMES a selector would
// otherwise false-positive a naive text search. Mirrors
// assistantCloseMotionCss.test.js's own helper.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

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

// The property each comma-separated `transition` segment names, splitting on
// TOP-LEVEL commas only — var(--x, fallback) and cubic-bezier(...) both carry
// commas of their own that a naive split would trip on.
function animatedProperties(ruleBody) {
  const start = ruleBody.indexOf("transition:");
  assert.ok(start >= 0, "expected a transition shorthand in this rule");
  const value = ruleBody.slice(start + "transition:".length, ruleBody.indexOf(";", start));
  const segments = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim().split(/\s+/)[0]);
}

// Every flat `selector { body }` rule inside one already-extracted block.
// Selectors are normalised to one line so a multi-line selector list reads the
// same as a single-line one.
function flatRules(block) {
  const rules = [];
  const inner = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(inner)) !== null) {
    rules.push({
      selector: match[1].trim().replace(/\s*\n\s*/g, " "),
      body: match[2],
    });
  }
  return rules;
}

test("the exit collapses to the brief's pinned pose on Task 1's zoop spring and duration variables", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));
  const rule = extractRule(css, '.assistant-pill-presence[data-pill-exit="zoop"] {');
  assert.ok(rule, "expected a zoop exit rule for .assistant-pill-presence");

  assert.match(
    rule,
    /transform:\s*scale\(0\.04,\s*0\.03\);/,
    "the pill collapses to 4% with the 2px squash"
  );
  assert.match(rule, /opacity:\s*0;/);
  assert.match(rule, /pointer-events:\s*none;/);
  assert.match(
    rule,
    new RegExp(
      `transform var\\(--motion-zoop-ms, ${MOTION_TIMING.zoopMs}ms\\) var\\(--motion-zoop-ease,`
    ),
    "the collapse must read Task 1's zoop variables, with a fallback matching MOTION_TIMING.zoopMs"
  );
  // Opacity leaves over the last 40% of the zoop: an 80ms fade after a 120ms
  // delay. Derived from the pinned duration, never retyped.
  const fadeMs = MOTION_TIMING.zoopMs * 0.4;
  const delayMs = MOTION_TIMING.zoopMs - fadeMs;
  assert.match(rule, new RegExp(`opacity ${fadeMs}ms linear ${delayMs}ms`));

  assert.deepEqual(
    animatedProperties(rule),
    ["transform", "opacity"],
    "only transform and opacity may animate here — never width, height or a layout property"
  );
});

test("the pill's resting rule owns the unzoop on Task 1's show spring, and animates nothing but transform and opacity", async () => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));
  // The base rule is what plays on the way BACK: removing data-pill-exit
  // transitions the transform to none over the show spring's 260ms (whose
  // ~4% overshoot is the spring's own, from springLinearEasing(380, 28)).
  const rule = extractRule(css, ".assistant-pill-presence {\n  --pill-exit-origin");
  assert.ok(
    rule,
    "expected .assistant-pill-presence to declare the exit origin and its transition"
  );
  assert.match(
    rule,
    new RegExp(
      `transform var\\(--motion-show-ms, ${MOTION_TIMING.showMs}ms\\) var\\(--motion-show-ease,`
    ),
    "the return must read Task 1's show variables, with a fallback matching MOTION_TIMING.showMs"
  );

  assert.deepEqual(
    animatedProperties(rule),
    ["transform", "opacity"],
    "only transform and opacity may animate here — never width, height or a layout property"
  );
});

test("the exit origin follows the dock and never reaches the Assistant footer's own animations", () => {
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));

  assert.match(
    css,
    /\.assistant-pill-presence \{\n {2}--pill-exit-origin: calc\(100% - 20px\) 50%;/
  );
  assert.match(
    css,
    /\.assistant-pill-presence\[data-horizontal-direction="left"\] \{\n {2}--pill-exit-origin: 20px 50%;/
  );
  assert.match(
    css,
    /\.voice-pill-position-center \.assistant-pill-presence \{\n {2}--pill-exit-origin: 50% 50%;/
  );

  // The origin is applied only while no footer phase is active. The base rule
  // at the top of this file gives the SAME element `transform-origin:
  // var(--assistant-footer-origin)` (right/left center) for the panel
  // footer's enter/retreat keyframes; an unscoped override here would move
  // the anchor those scale(0.68) animations pivot on, silently retuning
  // Task 6/7's shipped choreography. :not() raises specificity, so it wins
  // exactly when it matches and yields when a footer phase is present.
  const applied = extractRule(css, ".assistant-pill-presence:not([data-assistant-footer-phase]) {");
  assert.ok(applied, "the exit origin must be scoped away from the footer phases");
  assert.match(applied, /transform-origin: var\(--pill-exit-origin\);/);
  assert.doesNotMatch(
    css,
    /\n\.assistant-pill-presence \{\n(?:(?!\n\}).)*transform-origin: var\(--pill-exit-origin\)/s,
    "the exit origin must never be declared on the unscoped .assistant-pill-presence rule"
  );
});

test("reduced motion shortens the exit with a single broadcast value, and never names .voice-pill-position", () => {
  const css = readCss("src/styles/dictation-panel.css");
  const block = stripCssComments(
    extractBalancedBlock(css, "@media (prefers-reduced-motion: reduce)")
  );
  assert.ok(block, "expected dictation-panel.css to have its own reduced-motion media block");

  const rule = extractRule(block, '.assistant-pill-presence[data-pill-exit="zoop"] {');
  assert.ok(rule, "expected a reduced-motion override for the pill's exit transition");
  // ONE duration and ONE delay: index.css forces transition-property to its
  // own fixed list without touching duration, so a multi-value list here
  // would be matched by POSITION against that forced list and cycle onto the
  // wrong property. A single value broadcasts to all of them.
  assert.match(rule, /transition-duration: 1ms !important;/);
  assert.match(rule, /transition-delay: 0ms !important;/);
  assert.equal((rule.match(/transition-duration:/g) ?? []).length, 1);
  assert.doesNotMatch(
    rule,
    /transition-duration:[^;]*,/,
    "a comma-separated duration list would cycle onto index.css's forced property list"
  );

  // Fix round 1, finding 4: the override must reach the ZOOP only. The bare
  // .assistant-pill-presence also owns the tip-card in-place-of-pill opacity
  // swap, and index.css's reduced-motion policy is explicit that opacity
  // keeps its normal speed — collapsing that swap to 1ms works against it.
  const overrides = flatRules(block).filter(
    (candidate) =>
      candidate.selector.includes(".assistant-pill-presence") &&
      /transition-(duration|delay)/.test(candidate.body)
  );
  assert.deepEqual(
    overrides.map((candidate) => candidate.selector),
    ['.assistant-pill-presence[data-pill-exit="zoop"]'],
    "no reduced-motion transition override may target the bare .assistant-pill-presence"
  );
});
