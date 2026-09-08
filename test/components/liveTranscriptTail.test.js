// Covers Task 10's live-transcript tail: the stepped `background-clip` sweep
// is replaced by per-word spans that carry ONLY an opacity change — the
// newest words sit at 62% and settle to 100% when they leave the active
// window. Both halves are checked: what LiveTranscriptPanel renders (word
// spans, stable keys via the absolute index, `data-active` only on the newest
// window) and what the stylesheet does with them.
//
// Verified from rendered markup and CSS text, not a live browser: the actual
// interpolation from 0.62 to 1 is the browser's, and this harness cannot
// sample it. What it can prove is that the DOM identity survives a delta (so
// there IS something to transition) and that the rule can only ever animate
// opacity.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const sourceRoot = path.resolve(__dirname, "../..");
const readCss = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), "utf8");

// Strip comments first: a comment that merely NAMES a selector would
// otherwise false-positive a naive text search. Mirrors the helper proven in
// pillZoopMotionCss.test.js / streamingReplyMotionCss.test.js.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function extractRule(source, selectorText) {
  const start = source.indexOf(selectorText);
  if (start < 0) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) return null;
  const closeBrace = source.indexOf("}", openBrace);
  if (closeBrace < 0) return null;
  assert.ok(
    !source.slice(openBrace + 1, closeBrace).includes("{"),
    `extractRule used on a block with nested braces: ${selectorText}`
  );
  return source.slice(openBrace + 1, closeBrace);
}

// The property each comma-separated `transition` segment names, splitting on
// TOP-LEVEL commas only.
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

// The harness renders i18n keys verbatim (no i18next instance is
// initialized), so the empty-transcript assertion matches the raw key.
async function renderPanel(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-live-transcript-tail-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/LiveTranscriptPanel.tsx");
  return renderToStaticMarkup(
    createElement(mod.LiveTranscriptPanel, {
      text: "",
      measurementText: "",
      phase: "live",
      processing: false,
      controlsVisible: true,
      contentVisible: true,
      onCollapse: () => {},
      ...props,
    })
  );
}

const words = (count) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

// The two paragraphs that must agree: the visible transcript and the hidden
// node the shell measures its preferred height against. Tags are stripped
// rather than parsed — the only elements inside either are the tail's own
// <span>s, and what is under test is the TEXT they add up to.
const stripTags = (html) => html.replace(/<[^>]*>/g, "");

const visibleTranscript = (markup) => {
  const match = markup.match(/<p class="select-text[^"]*">([\s\S]*?)<\/p>/);
  assert.ok(match, "expected the visible transcript paragraph");
  return stripTags(match[1]);
};

const measuredTranscript = (markup) => {
  const match = markup.match(/data-panel-size-source[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(match, "expected the hidden measurement paragraph");
  return stripTags(match[1]);
};
const activeWords = (markup) => [
  ...markup.matchAll(/<span class="live-transcript-word" data-active="true">([^<]*)<\/span>/g),
].map((match) => match[1].trim());
const tailWords = (markup) => [
  ...markup.matchAll(/<span class="live-transcript-word"(?: data-active="true")?>([^<]*)<\/span>/g),
].map((match) => match[1].trim());

test("a streaming transcript renders its tail per word, with only the newest window active", async (t) => {
  const markup = await renderPanel(t, { text: words(15), phase: "live" });

  assert.deepEqual(
    tailWords(markup),
    ["w3", "w4", "w5", "w6", "w7", "w8", "w9", "w10", "w11", "w12", "w13", "w14"],
    "the twelve tail words stay individually rendered so their settle can transition"
  );
  assert.deepEqual(
    activeWords(markup),
    ["w9", "w10", "w11", "w12", "w13", "w14"],
    "only the newest six words sit at the dimmed active opacity"
  );
  assert.match(markup, /<span>w0 w1 w2 <\/span>/, "everything older is one settled string");
  assert.doesNotMatch(
    markup,
    /inline-response-shimmer/,
    "the stepped background-clip sweep must no longer be referenced by the transcript"
  );
});

// The commit. Once the transcript stops streaming, the words that were at 62%
// must keep their spans and merely lose `data-active`, so the opacity
// TRANSITIONS to 100%. Collapsing straight to one settled string would
// unmount them and snap — the "62% -> 100% on commit" half of the spec row
// would never actually play.
test("committing the transcript keeps the dimmed words' spans and only drops data-active", async (t) => {
  const streaming = await renderPanel(t, { text: words(15), phase: "live" });
  const committed = await renderPanel(t, { text: words(15), phase: "final" });

  assert.deepEqual(activeWords(committed), [], "a committed transcript has nothing left at 62%");
  const stillActive = activeWords(streaming);
  const kept = new Set(tailWords(committed));
  for (const word of stillActive) {
    assert.ok(
      kept.has(word),
      `${word} was at 62% while streaming and must keep its span through the commit`
    );
  }
});

test("an empty transcript renders the waiting copy and no tail spans at all", async (t) => {
  const markup = await renderPanel(t, { text: "", phase: "listening" });

  assert.match(markup, /transcriptionPreview\.waitingForInput/);
  assert.deepEqual(tailWords(markup), []);
});

test("the tail rule animates opacity and nothing else, on a single broadcastable duration", async () => {
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));

  const rule = extractRule(css, ".live-transcript-word {");
  assert.ok(rule, "expected a .live-transcript-word rule");
  assert.match(rule, /opacity:\s*1;/, "a settled word sits at full opacity");
  assert.deepEqual(
    animatedProperties(rule),
    ["opacity"],
    "opacity-only: nothing here may repaint text or move layout"
  );
  // ONE duration, never a list. index.css's blanket reduced-motion rule
  // forces transition-property to its own fixed list without touching
  // duration, so a comma-separated duration would be matched by POSITION
  // against that forced list and cycle onto the wrong property — the trap
  // .voice-pill-position hit, and the one the base .assistant-pill-presence
  // rule hit after it. A single value broadcasts to all of them, which is
  // also why this rule needs no reduced-motion override of its own: opacity
  // is in index.css's forced list and keeps its normal speed there, exactly
  // as that file's own policy intends. animatedProperties splits on TOP-LEVEL
  // commas, so its single entry already proves the shorthand is one segment —
  // and therefore contributes exactly one duration, whatever a future var()
  // fallback's own commas might look like.
  assert.equal(animatedProperties(rule).length, 1, "a duration list here could cycle onto opacity");

  const active = extractRule(css, '.live-transcript-word[data-active="true"] {');
  assert.ok(active, "expected an active-word rule");
  assert.match(active, /opacity:\s*0\.62;/, "the newest words sit at 62%");
  assert.doesNotMatch(
    active,
    /transition|transform|background|color/,
    "the active state is an opacity value only — it must not re-declare motion or paint"
  );
});

// Nothing is removed in this PR: the superseded shimmer rule and its
// keyframes stay in the stylesheet even though the transcript no longer
// references them.
test("the superseded background-clip shimmer rule and keyframes remain in the stylesheet", async () => {
  const css = stripCssComments(readCss("src/styles/dictation-panel.css"));

  // Anchored on the base rule's OWN first declaration. `.inline-response-shimmer {`
  // alone also matches its reduced-motion override further down the file, so a
  // bare text search cannot tell which of the two survived — proven during this
  // task's bite-check, where renaming the base rule left the naive version green.
  const base = extractRule(css, ".inline-response-shimmer {\n  color: transparent;");
  assert.ok(base, "the superseded shimmer rule stays in the stylesheet, simply unused");
  assert.match(base, /background-clip: text;/);
  assert.match(base, /animation: inline-response-shimmer 2\.2s steps\(24, end\) infinite;/);
  assert.match(css, /@keyframes inline-response-shimmer \{/);
});

// Fix round 1, finding 1. The transcript paragraph is `whitespace-pre-wrap`
// precisely because the cleanup prompt (src/locales/en/prompts.json) asks the
// model to turn spoken "new line" into a real break and to emit bullet lists,
// numbered steps, paragraph breaks between topics, and email layout. The tail
// therefore has to carry the ACTUAL whitespace between words, not a single
// space per gap — otherwise a cleaned-up dictation renders as one run-on line
// and stays that way for the whole 4s final hold.
//
// Asserting equality with the source (rather than "contains a newline") also
// covers the second-order defect: the hidden measurement node at
// data-panel-size-source renders `measurementText` RAW, and both it and `text`
// are the same trimmed source string, so any whitespace the visible node drops
// makes the shell size itself against a taller box than the text occupies.
const BREAK_SHAPES = {
  "a spoken new line": "alpha bravo charlie\nsecond line here delta echo foxtrot golf",
  "a paragraph break":
    "first paragraph opening line here\n\nsecond paragraph continues with more words and then some more to push past the window",
  "a bullet list":
    "- buy milk\n- call the dentist\n- send the invoice today\n- book the flight home tomorrow",
};

for (const [shape, transcript] of Object.entries(BREAK_SHAPES)) {
  for (const phase of ["live", "final"]) {
    test(`${shape} keeps its breaks in the rendered tail at phase "${phase}"`, async (t) => {
      const markup = await renderPanel(t, { text: transcript, measurementText: transcript, phase });

      assert.equal(
        visibleTranscript(markup),
        transcript,
        "the rendered transcript must be the source, character for character — breaks included"
      );
      assert.ok(
        visibleTranscript(markup).includes("\n"),
        "fixture sanity: this shape is only interesting because it contains a break"
      );
    });
  }

  test(`${shape} leaves the measurement node and the visible node in agreement`, async (t) => {
    const streaming = await renderPanel(t, {
      text: transcript,
      measurementText: transcript,
      phase: "live",
    });
    const committed = await renderPanel(t, {
      text: transcript,
      measurementText: transcript,
      phase: "final",
    });

    for (const markup of [streaming, committed]) {
      assert.equal(
        visibleTranscript(markup),
        measuredTranscript(markup),
        "the shell sizes itself against the hidden node; a visible node that differs opens the panel taller than its text"
      );
    }
  });
}
