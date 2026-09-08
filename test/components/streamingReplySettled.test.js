// Covers the core guarantee of Task 5 (streaming reply, per-word rise): once
// a paragraph has settled, it must never re-render as later tokens grow the
// tail — only the tail re-renders per token. A test that only inspects
// rendered markup cannot catch a re-render (two renders of unchanged content
// can look identical), so this mounts the REAL AssistantPanel with the REAL
// MarkdownRenderer/rehypeWordRise/splitStreamingMarkdown (nothing mocked
// along that path) via react-dom/client's createRoot, and watches actual DOM
// node identity across simulated streaming updates.
//
// Why DOM node identity is a decisive signal here (not just "probably fine"):
// MarkdownRenderer.tsx builds its react-markdown `components` map inline, as
// fresh arrow functions on every call — those functions ARE the React
// element "type" for each rendered tag. If StableAssistantMarkdown's memo
// bails out, MarkdownRenderer never runs again and nothing changes. If it
// does NOT bail out (the split broke), MarkdownRenderer runs again, produces
// a brand-new `components` map, and every one of its custom-typed elements
// (every <p>, <strong>, ...) gets a *different* type on the next reconcile —
// forcing React to unmount and remount them, not patch them in place. So an
// unwanted re-render is not a maybe here: it always changes DOM node
// identity for the whole settled subtree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installInteractiveDom,
  findElement,
  findAllElements,
} = require("../lib/rendererTestHarness");

const noop = () => {};

// Mounts the REAL AssistantPanel with everything except its heavy app-wiring
// dependencies mocked (same list test/helpers/assistantPanel.test.js already
// proves works with createRoot) — crucially, /ui/MarkdownRenderer is NOT
// mocked, so the real split/memo/rehype pipeline under test actually runs.
async function mountStreamingAssistantPanel(t) {
  // t.after hooks run in registration order (FIFO), so the unmount hook must
  // be registered BEFORE installBrowserGlobals/installInteractiveDom's own
  // cleanup — otherwise window/document are already torn down by the time
  // root.unmount() runs, throwing "window is not defined" (mirrors the
  // ordering test/helpers/assistantPanel.test.js's proven tests use).
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  globalThis.__streamMessages = [];
  t.after(() => {
    delete globalThis.__streamMessages;
    delete globalThis.__setStreamMessages;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-streaming-reply-test-",
    mockModules: {
      "lucide-react": `
        import React from "react";
        const Icon = () => React.createElement("span");
        export const Check = Icon;
        export const Copy = Icon;
        export const Plus = Icon;
        export const X = Icon;
      `,
      "/chat/useChatPersistence": `
        import { useState } from "react";
        export function useChatPersistence() {
          const [messages, setMessages] = useState(globalThis.__streamMessages);
          globalThis.__setStreamMessages = setMessages;
          return {
            messages,
            setMessages,
            conversationId: null,
            async createConversation() { return 1; },
            async loadConversation() {},
            saveUserMessage() {},
            saveAssistantMessage() {},
            handleNewChat() { setMessages([]); },
          };
        }
      `,
      "/chat/useChatStreaming": `
        export function useChatStreaming() {
          return { agentState: "idle", activeToolName: null, toolStatus: "", cancelStream() {} };
        }
      `,
      "/chat/useChatMessageSender": `
        export function useChatMessageSender() { return async () => true; }
      `,
      "/chat/ChatInput": `
        import React from "react";
        export function ChatInput() { return React.createElement("input"); }
      `,
      "/dictation/AssistantEmptyState": `
        import React from "react";
        export function AssistantEmptyState() { return React.createElement("div", null, "Empty state"); }
      `,
      "/dictation/BrandMarkIcon": `
        import React from "react";
        export function BrandMarkIcon() { return React.createElement("span"); }
      `,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "/hooks/useWindowDrag": `
        export function useWindowDrag() { return { handleMouseDown() {}, handleMouseUp() {} }; }
      `,
      "/hooks/useCopyFeedback": `
        export function useCopyFeedback() {
          return { copied: false, async copy() {}, confirmCopied() {} };
        }
      `,
      "/stores/settingsStore": `
        const state = { voiceAgentKey: [] };
        export function useSettingsStore(selector) { return selector(state); }
      `,
      "/utils/hotkeys": `
        export function formatHotkeyListLabel() { return ""; }
      `,
      "/ui/useToast": `
        export function useToast() { return { toast() {} }; }
      `,
      // /ui/MarkdownRenderer is deliberately NOT mocked — this test exists to
      // exercise the real split/memo/rehype pipeline, not a stand-in for it.
    },
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await viteI18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation } },
    interpolation: { escapeValue: false },
  });
  const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
  const { createRoot } = require("react-dom/client");

  root = createRoot(container);

  await React.act(async () =>
    root.render(
      React.createElement(AssistantPanel, {
        pendingCommand: null,
        onCommandConsumed: noop,
        onCommandDiscarded: noop,
        onCommandSettled: noop,
        initialConversationId: null,
        onConversationIdChange: noop,
        voiceState: "idle",
        thinking: false,
        open: true,
        footerPhase: "pill",
        horizontalDirection: "right",
        onClose: noop,
        onBusyChange: noop,
        onResponseReadyChange: noop,
        onResponseContent: noop,
        onConversationReset: noop,
        onSelectionContextChange: noop,
      })
    )
  );

  // id defaults to a fixed value (the existing behavior every prior test
  // relies on: one continuous message growing across calls) — pass a
  // DIFFERENT id to simulate a genuinely new reply starting.
  const setAssistantMessage = async (content, isStreaming, id = "assistant-1") => {
    await React.act(async () => {
      globalThis.__setStreamMessages([{ id, role: "assistant", content, isStreaming }]);
    });
  };

  return { container, setAssistantMessage };
}

const findSettledParagraph = (container, text) =>
  findElement(container, (el) => el.tagName === "P" && el.textContent.includes(text));

const riseSpans = (container) =>
  findAllElements(container, (el) => el.tagName === "SPAN" && el.getAttribute("data-rise") === "true");

// EVERY word rehypeWordRise touches gets wrapped in a span carrying
// data-word-index, whether or not it also gets data-rise (a "no longer
// new" word keeps the wrapper span, just without the rise attributes). So
// "no rise spans" alone does not prove a paragraph skipped rehypeWordRise
// entirely — a word that arrived, then simply aged out of "new" before the
// next check, would also show zero data-rise spans while still being
// word-wrapped. This is the stronger, decisive signal for "rendered as
// plain markdown, never touched by the tail's word-wrap pipeline at all".
const wordWrappedSpans = (container) =>
  findAllElements(container, (el) => el.tagName === "SPAN" && el.getAttribute("data-word-index") !== null);

test("a settled paragraph keeps its DOM identity across tail-only growth, but genuinely re-renders once new content joins it — and the whole reply collapses to one plain block when streaming ends", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // Stage 1: two settled paragraphs plus a two-word tail.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot", true);
  const settledNode = findSettledParagraph(container, "Alpha bravo.");
  assert.ok(settledNode, "expected the first settled paragraph to be rendered");
  assert.equal(
    findSettledParagraph(container, "Charlie delta.")?.getAttribute("data-rise"),
    null,
    "settled paragraphs must never carry a rise trigger themselves"
  );
  assert.ok(riseSpans(container).length > 0, "expected the tail to actually be word-wrapped by rehypeWordRise");
  // No settled word is ever wrapped with a rise trigger — only tail words are.
  for (const span of riseSpans(container)) {
    assert.ok(
      "Echo foxtrot".includes(span.textContent),
      `a settled word ("${span.textContent}") must never carry a rise trigger`
    );
  }

  // Stage 2: tail grows (same settled prefix). The settled paragraph's own
  // DOM node must be the exact same object — not just equal-looking markup.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf", true);
  assert.equal(
    findSettledParagraph(container, "Alpha bravo."),
    settledNode,
    "the settled paragraph must keep its DOM identity while only the tail grows"
  );

  // Stage 3: tail grows again. Still the same settled node — two growths in a
  // row, not a one-off coincidence.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel", true);
  assert.equal(
    findSettledParagraph(container, "Alpha bravo."),
    settledNode,
    "the settled paragraph must still keep its DOM identity after a second tail growth"
  );

  // Stage 4: a new paragraph boundary passes — settled content itself
  // genuinely changes (a new paragraph joins it). Since fix round 3,
  // finding 2 (MarkdownRenderer's components map is now a stable, hoisted
  // reference — see MarkdownRenderer.tsx), "Alpha bravo." itself no longer
  // loses its DOM identity here either: react-markdown re-parses the whole
  // settled string, but because the <p> type reference is now stable,
  // React's reconciliation can patch the EXISTING, unchanged first
  // paragraph in place and only mount a DOM node for the genuinely new
  // second one — an improvement over the original design (which tore down
  // and rebuilt the whole settled subtree on every genuine boundary
  // advance, not just spuriously). This must still NOT be a no-op, though
  // — proven differently now: "Echo", which WAS a risen tail span one
  // stage ago, must no longer be found as a span AT ALL once its sentence
  // settles (rendered from here on as plain text via the memoized,
  // rehypeWordRise-free settled path) — a real, detectable representation
  // change, not just "nothing ever happens".
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia", true);
  const settledNodeAfterBoundary = findSettledParagraph(container, "Alpha bravo.");
  assert.equal(
    settledNodeAfterBoundary,
    settledNode,
    "the first settled paragraph's DOM identity now survives a genuine settled-boundary advance too, thanks to fix round 3's stable components map"
  );
  assert.ok(
    findSettledParagraph(container, "Echo foxtrot golf hotel."),
    "the paragraph that just settled should render as plain, non-animated text"
  );
  assert.equal(
    findSettledParagraph(container, "Echo foxtrot golf hotel.").getAttribute("data-rise"),
    null
  );
  assert.ok(
    !riseSpans(container).some((span) => span.textContent === "Echo"),
    "'Echo' must no longer be found as a risen span once its sentence settles — the non-vacuous proof this test relies on now that settled paragraph identity itself is stable"
  );
  // The new (shorter) tail's own word must still actually rise — this is
  // the settled-boundary reset path (risenWordsRef's Map is replaced with a
  // fresh, empty one whenever settledMarkdown itself changes, since a
  // paragraph boundary just moved words out from under the tail and the new
  // tail's real indices restart at 0 — fix round 1, findings 1+3). Asserting
  // only "no OTHER word wrongly rises" (the loop below) would pass
  // vacuously if this reset broke and "India" silently lost its own rise
  // trigger instead.
  const newTailSpans = riseSpans(container);
  assert.equal(newTailSpans.length, 1, 'expected exactly one rise span ("India") after the boundary reset');
  assert.equal(newTailSpans[0].textContent, "India");
  for (const span of newTailSpans) {
    assert.ok(
      "India".includes(span.textContent),
      `only the new tail ("India") may carry a rise trigger, not "${span.textContent}"`
    );
  }

  // Stage 5: streaming ends. Per the brief: "When streaming ends the whole
  // reply renders as one plain block" — no live tail, so no rise spans left
  // anywhere, even though the words that were briefly a tail are still on screen.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia", false);
  assert.match(container.textContent, /India/);
  assert.equal(riseSpans(container).length, 0, "a finished reply must carry no rise triggers at all");
  // The stronger check: "India" must not be word-wrapped AT ALL (not even a
  // rise-less span carrying data-word-index) — it went through the plain
  // settled path, never through rehypeWordRise. "No rise spans" alone would
  // pass for the wrong reason if a future change reintroduced the
  // pre-fix-round conditional "isNew" marking this design replaced: a word
  // that aged out of "new" there lost data-rise while remaining
  // word-wrapped, so a check that only looks for data-rise wouldn't catch
  // the split still (wrongly) reaching rehypeWordRise at end-of-stream. The
  // current design has no such state — every word rehypeWordRise touches is
  // unconditionally marked (fix round 1) — so this assertion is currently
  // implied by the one above; it's the one that would catch that specific
  // regression shape if it ever came back.
  assert.equal(
    wordWrappedSpans(container).length,
    0,
    "a finished reply must not be word-wrapped at all — it must never reach rehypeWordRise"
  );
});

test("the tail's per-word rise delay is wired to MOTION_TIMING.wordStaggerMs, not a retyped literal", async (t) => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // A tail that arrives as three words in a single update: each is brand
  // new to risenWords (nothing has risen yet in this call), so their delays
  // are 0, 1x, and 2x the real stagger constant — computed from the import,
  // never retyped, so a future change to MOTION_TIMING.wordStaggerMs keeps
  // this test honest instead of quietly drifting.
  await setAssistantMessage("Echo foxtrot golf", true);
  const spans = riseSpans(container).sort(
    (a, b) => Number(a.getAttribute("data-word-index")) - Number(b.getAttribute("data-word-index"))
  );
  assert.deepEqual(
    spans.map((s) => s.textContent),
    ["Echo", "foxtrot", "golf"]
  );
  // React sets inline style properties via direct camelCase JS-property
  // assignment (node.style.animationDelay = ...), not node.style.setProperty
  // with the kebab-case CSS name — see react-dom's setValueForStyles.
  assert.deepEqual(
    spans.map((s) => s.style.animationDelay),
    [
      `${0 * MOTION_TIMING.wordStaggerMs}ms`,
      `${1 * MOTION_TIMING.wordStaggerMs}ms`,
      `${2 * MOTION_TIMING.wordStaggerMs}ms`,
    ]
  );
});

// Fix round 1, finding 1: the word-index bookkeeping used to derive
// firstNewWordIndex from countWords(tailMarkdown) — a count of
// whitespace-separated RAW MARKDOWN tokens. Markdown syntax ("- ", "1. ",
// "## ", "> ") tokenizes into extra "words" there that do not exist once
// actually rendered (rehypeWordRise counts only real, parsed words), so the
// two counts permanently disagree for anything but a plain paragraph — the
// threshold overshoots the real index and, within a couple of renders, NO
// further real word is ever marked as new again. A plain-paragraph fixture
// cannot see this (its raw token count and real word count happen to match
// exactly), which is exactly why every fixture up to this point missed it.
//
// Each case below streams the SAME content across three growing stages
// (mirroring real token-by-token arrival) and asserts that words from every
// stage — not just the very first one ever seen — eventually carry a rise
// trigger.
async function assertAllWordsEventuallyRise(t, stages, expectedWords) {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  for (const content of stages) {
    await setAssistantMessage(content, true);
  }
  const risenTexts = new Set(riseSpans(container).map((span) => span.textContent));
  for (const word of expectedWords) {
    assert.ok(
      risenTexts.has(word),
      `expected "${word}" to have risen at some point; words that actually rose: ${[...risenTexts].join(", ") || "(none)"}`
    );
  }
}

test("a bullet list's later items still rise, not just the first word ever seen (fix round 1, finding 1)", async (t) => {
  await assertAllWordsEventuallyRise(
    t,
    ["- Alpha", "- Alpha\n- Bravo", "- Alpha\n- Bravo\n- Charlie"],
    ["Alpha", "Bravo", "Charlie"]
  );
});

test("an ordered list's later items still rise, not just the first word ever seen (fix round 1, finding 1)", async (t) => {
  await assertAllWordsEventuallyRise(
    t,
    ["1. Alpha", "1. Alpha\n2. Bravo", "1. Alpha\n2. Bravo\n3. Charlie"],
    ["Alpha", "Bravo", "Charlie"]
  );
});

test("a heading followed by paragraph text still rises past the heading (fix round 1, finding 1)", async (t) => {
  await assertAllWordsEventuallyRise(
    t,
    ["## Alpha", "## Alpha\nBravo", "## Alpha\nBravo Charlie"],
    ["Alpha", "Bravo", "Charlie"]
  );
});

test("a blockquote's later words still rise, not just the first word ever seen (fix round 1, finding 1)", async (t) => {
  await assertAllWordsEventuallyRise(
    t,
    ["> Alpha", "> Alpha Bravo", "> Alpha Bravo Charlie"],
    ["Alpha", "Bravo", "Charlie"]
  );
});

// Fix round 1, finding 3: firstNewWordIndex used to be a single threshold
// recomputed every render, so a word marked "new" this render fell back
// below the (advancing) threshold on the very next one — cancelling its
// still-in-flight CSS animation and snapping it to its end state, rather
// than letting the started rise finish. The direct, decisive signal is
// this: once a word is assigned a delay, that EXACT delay must never
// change while it's still in the tail — recomputing it (even to the "same"
// value by coincidence) is exactly the bug; asserting byte-identical style
// strings across renders is what would catch a regression back to
// per-render recomputation.
test("a word's rise delay never changes once assigned — an in-flight animation is never restarted (fix round 1, finding 3)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage("Echo foxtrot", true);
  const echoBefore = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.ok(echoBefore, "expected Echo to have risen on its first appearance");
  const echoDelay = echoBefore.style.animationDelay;

  await setAssistantMessage("Echo foxtrot golf", true);
  const echoAfterOneGrowth = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.ok(echoAfterOneGrowth, "Echo must still be marked risen after the tail grows once");
  assert.equal(
    echoAfterOneGrowth.style.animationDelay,
    echoDelay,
    "Echo's delay must be the exact same value — a changed value means its animation was recomputed, i.e. restarted"
  );

  await setAssistantMessage("Echo foxtrot golf hotel", true);
  const echoAfterTwoGrowths = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.equal(
    echoAfterTwoGrowths?.style.animationDelay,
    echoDelay,
    "still unchanged after a second growth — sticky, not a one-render coincidence"
  );
});

// Fix round 1, finding 2: settled and tail are two INDEPENDENT documents —
// each parsed on its own by a separate MarkdownRenderer call — so a
// boundary that split a list, a fenced code block, or a blockquote used to
// produce genuinely wrong rendered output (not just an animation
// imperfection). These three tests drive the real component through the
// exact symptoms the fix round measured, rather than only checking
// splitStreamingMarkdown's boundary decisions in isolation (which cannot
// prove what actually reaches the screen).
test("a numbered list never splits into two <ol> elements while streaming, and settles as one unit (fix round 1, finding 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  const listItems = () => findAllElements(container, (el) => el.tagName === "LI");
  const orderedLists = () => findAllElements(container, (el) => el.tagName === "OL");

  await setAssistantMessage("1. First", true);
  assert.equal(orderedLists().length, 1, "one item so far: exactly one <ol>");
  assert.equal(listItems().length, 1);

  await setAssistantMessage("1. First\n\n2. Second", true);
  assert.equal(
    orderedLists().length,
    1,
    "a second item must join the SAME list — a split boundary would have produced a fresh, separately-numbered <ol> here"
  );
  assert.equal(listItems().length, 2);

  await setAssistantMessage("1. First\n\n2. Second\n\n3. Third", true);
  assert.equal(orderedLists().length, 1, "a third item must still be the same single list");
  assert.equal(listItems().length, 3);

  // A genuinely new block (not itself list-shaped) follows: the list is now
  // complete and settles as one unit — still exactly one <ol>, never two.
  await setAssistantMessage("1. First\n\n2. Second\n\n3. Third\n\nAfter", true);
  assert.equal(orderedLists().length, 1, "the completed list must still be a single <ol>, not split across settled/tail");
  assert.equal(listItems().length, 3);
  assert.match(container.textContent, /After/);
});

test("a fenced code block's internal blank line never renders as a stray paragraph while the fence is still open (fix round 1, finding 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  const codeBlocks = () => findAllElements(container, (el) => el.tagName === "PRE");
  const strayParagraphs = () =>
    findAllElements(container, (el) => el.tagName === "P" && el.textContent.includes("code2"));

  await setAssistantMessage("Before.\n\n```js\ncode1", true);
  assert.equal(codeBlocks().length, 1, "the opening fence must render as a code block from its first line");

  // The blank line INSIDE the still-open fence looks exactly like a
  // paragraph boundary by text alone — this is the specific case that used
  // to split the fence's opener away from its own content.
  await setAssistantMessage("Before.\n\n```js\ncode1\n\ncode2", true);
  assert.equal(
    strayParagraphs().length,
    0,
    "code2 must never render as a plain paragraph while the fence is still open"
  );
  assert.equal(codeBlocks().length, 1, "still one code block, now containing both lines");
  assert.match(codeBlocks()[0].textContent, /code1/);
  assert.match(codeBlocks()[0].textContent, /code2/);

  // The fence closes, followed by unrelated text: still exactly one code
  // block, and the following text is plain, not swallowed into it.
  await setAssistantMessage("Before.\n\n```js\ncode1\n\ncode2\n```\n\nAfter", true);
  assert.equal(codeBlocks().length, 1);
  assert.equal(strayParagraphs().length, 0);
  assert.match(container.textContent, /After/);
});

test("a loose list settles with every item consistently loose — never a tight/loose mismatch between older and newest items (fix round 1, finding 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  const listItems = () => findAllElements(container, (el) => el.tagName === "LI");
  const looseness = () => listItems().map((li) => li.childNodes.some((child) => child.tagName === "P"));
  const assertUniformLooseness = (stageLabel) => {
    const flags = looseness();
    assert.ok(
      flags.every((isLoose) => isLoose === flags[0]),
      `at "${stageLabel}", every item must share the same loose/tight rendering, got: ${flags.join(", ")}`
    );
  };

  await setAssistantMessage("- First\n\n- Second", true);
  assertUniformLooseness("- First\n\n- Second");

  // Mid-list, before anything proves it complete: this is the specific
  // moment the bug showed up — a split boundary would have settled First
  // and Second together (loose, since a blank line separates them) while
  // Third sat alone in the tail (a single item, always tight on its own),
  // visibly reflowing the instant it later joined the settled list.
  await setAssistantMessage("- First\n\n- Second\n\n- Third", true);
  assertUniformLooseness("- First\n\n- Second\n\n- Third (still streaming)");

  // A trailing paragraph proves the list complete, settling all three items
  // together as ONE parse — so CommonMark's loose/tight determination (a
  // property of the WHOLE list, decided by whether ANY blank line
  // separates its items) is made once, consistently, instead of being
  // decided piecemeal as items crossed the boundary one at a time.
  await setAssistantMessage("- First\n\n- Second\n\n- Third\n\nAfter", true);
  assert.equal(listItems().length, 3);
  assertUniformLooseness("list complete");
});

// Fix round 2: an empty tail is NOT proof a list/blockquote has ended.
// useChatStreaming calls setMessages with the full accumulated content on
// every chunk, so a render landing exactly at "\n\n" — between finishing
// one loose-list item and the next one starting — is a routine mid-stream
// state, not a completion signal. Finding 2's original fix
// (isSafeSettledBoundary returning !looksLikeListOrQuote(candidateTail))
// treated that empty string as "doesn't look like a list/quote, so settle
// here" — settling the item alone, only for the very next token (the next
// item's marker) to prove the list continues, reverting the split and
// UN-settling what had just settled: the already-displayed <p> is detached
// and rebuilt, and its words regain data-rise, replaying their rise
// animation. That is exactly the twitching-settled-text failure this whole
// task exists to prevent. Two independent checks per the coordinator's own
// instruction: settled DOM identity alone would miss a word wrongly
// promoted to (then back out of) the settled path with identical-looking
// final markup; the data-rise check alone would miss a settled node being
// torn down and rebuilt. Both are asserted below.
//
// What this does NOT assert, deliberately: that Alpha's OWN tail span keeps
// the same DOM node identity once a SUBSEQUENT sibling word arrives (e.g.
// after "- Bravo" starts). Verified separately (a standalone check against
// MarkdownRenderer + rehypeWordRise, outside this suite) that this is
// already false for a plain paragraph with no list involved at all —
// MarkdownRenderer's `components` map is built inline and unmemoized, so
// every tail re-render gives every custom-mapped ancestor tag (p, li, ...)
// a fresh type reference, which forces React to remount their entire
// subtree regardless of the sticky, byte-identical delay VALUE fix round 1
// shipped. That is a real, separate concern (flagged in the report, not
// fixed here — out of scope for this finding, which is specifically about
// the settled/tail SPLIT, not per-render remounting within the tail) and
// asserting tail-span identity here would make this test fail for reasons
// unrelated to the boundary bug it exists to cover.
test("an empty tail right after a loose-list item is not proof the list ended — the settled prefix stays monotonic and Alpha never regains a rise trigger after being wrongly settled (fix round 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage("Intro para.\n\n- Alpha", true);
  const introNode = findSettledParagraph(container, "Intro para.");
  assert.ok(introNode, "expected the intro paragraph to already be settled once the list starts");
  const alphaBefore = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(alphaBefore, "expected Alpha to be a risen tail word as the list's first item streams in");

  // The chunk lands exactly at the "\n\n" boundary — content ends right
  // after Alpha's own trailing blank line, with nothing yet to prove
  // whether the list continues or has ended.
  await setAssistantMessage("Intro para.\n\n- Alpha\n\n", true);

  // Half 1: the settled prefix must keep its DOM identity through this
  // empty-tail moment — it must not be torn down because of what the
  // still-in-progress list does next.
  assert.equal(
    findSettledParagraph(container, "Intro para."),
    introNode,
    "the settled intro paragraph must keep its DOM identity through the empty-tail moment"
  );

  // Half 2: Alpha must still be found as a RISEN tail word, not have been
  // promoted to plain settled text. The identity check above alone would
  // not catch this — the intro paragraph's identity can stay perfectly
  // stable while Alpha incorrectly settles and un-settles around it. Under
  // the defect, Alpha is settled here (rendered as plain text via
  // StableAssistantMarkdown, no span, no data-rise at all).
  const alphaAtEmptyTail = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(
    alphaAtEmptyTail,
    "Alpha must still be a risen tail word at the empty-tail moment — an empty tail must never be read as proof the list ended"
  );

  // The next item's marker arrives. Under the defect, THIS is where Alpha
  // would have visibly un-settled — its plain-settled <p> detached,
  // replaced by a freshly risen span — as the split reverted. Confirm it
  // never had to: the settled prefix is still the same node, and Alpha is
  // (still) found risen with its delay VALUE unchanged (round 1's sticky
  // guarantee) rather than having cycled through settled and back.
  await setAssistantMessage("Intro para.\n\n- Alpha\n\n- Bravo", true);
  assert.equal(
    findSettledParagraph(container, "Intro para."),
    introNode,
    "the settled intro paragraph must still be the same node once the second item starts"
  );
  const alphaAfterBravo = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(alphaAfterBravo, "Alpha must still be found risen once Bravo starts — never settled in between");
  assert.equal(
    alphaAfterBravo.style.animationDelay,
    alphaAtEmptyTail.style.animationDelay,
    "Alpha's delay value must be unchanged — it was never removed from risenWords by a wrongful settle/un-settle cycle"
  );
});

test("an empty tail right after a blockquote line is not proof the blockquote ended (fix round 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage("Intro para.\n\n> Alpha", true);
  const introNode = findSettledParagraph(container, "Intro para.");
  assert.ok(introNode);
  const alphaBefore = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(alphaBefore, "expected Alpha to be a risen tail word as the blockquote's first line streams in");

  await setAssistantMessage("Intro para.\n\n> Alpha\n\n", true);
  assert.equal(
    findSettledParagraph(container, "Intro para."),
    introNode,
    "the settled intro paragraph must keep its DOM identity through the empty-tail moment"
  );
  const alphaAtEmptyTail = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(
    alphaAtEmptyTail,
    "Alpha must still be a risen tail word at the empty-tail moment — an empty tail must never be read as proof the blockquote ended"
  );

  await setAssistantMessage("Intro para.\n\n> Alpha\n\n> Bravo", true);
  assert.equal(findSettledParagraph(container, "Intro para."), introNode);
  const alphaAfterBravo = riseSpans(container).find((span) => span.textContent === "Alpha");
  assert.ok(alphaAfterBravo, "Alpha must still be found risen once Bravo starts — never settled in between");
  assert.equal(
    alphaAfterBravo.style.animationDelay,
    alphaAtEmptyTail.style.animationDelay,
    "Alpha's delay value must be unchanged"
  );
});

// Fix round 3, finding 1: round 2's fix covered the EMPTY-tail moment; the
// same defect reappears one character later for a BARE/PARTIAL marker
// ("-", "*", "3", "3.") — looksLikeListOrQuote requires trailing
// whitespace after the marker, so "-" alone also fails "looks like it
// continues" and licenses the identical wrongful ADVANCE (settling "a"
// alone, before its sibling item's marker has even fully arrived).
//
// What this does NOT assert: that the settled prefix's OWN identity stays
// unchanged the instant the bare marker appears. It does not, and per the
// "never shrink" invariant it is not required to — settling "a" alone
// there is a genuine, one-time, FORWARD move (verified separately: once
// "b" and then non-list content prove the list complete, "a" and "b"
// correctly rejoin into one settled block — see the trace in the report).
// The actual defect the coordinator measured is the step AFTER that: the
// bare marker's own trailing space arriving used to prove nothing and
// caused the settle to REVERSE — detaching the just-created settled node
// and moving "a" back into the tail, where it regains data-rise and
// replays its rise animation. That reversal is what must never happen: a
// word, once found settled, must never again be found risen.
function findWordStatus(container, word) {
  if (riseSpans(container).some((span) => span.textContent === word)) return "risen";
  if (findElement(container, (el) => el.tagName === "P" && el.textContent.includes(word))) return "settled";
  return "absent";
}

test("a bare list marker with no content yet does not cause a settled word to regress back to risen (fix round 3, finding 1)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  const introNode = () => findSettledParagraph(container, "Intro para.");

  const steps = [
    "Intro para.\n\n- a\n\n",
    "Intro para.\n\n- a\n\n-", // bare marker — this is where round 2 alone would wrongly advance
    "Intro para.\n\n- a\n\n- ", // marker's trailing space — this is where the OLD bug reversed it
    "Intro para.\n\n- a\n\n- b",
    "Intro para.\n\n- a\n\n- b\n\nAfter.", // proves the list complete: "a" and "b" settle together
  ];
  let previousStatus = null;
  for (const content of steps) {
    await setAssistantMessage(content, true);
    assert.ok(introNode(), "the intro paragraph must remain settled throughout");
    const status = findWordStatus(container, "a");
    assert.notEqual(status, "absent", `'a' must always be findable somewhere; step: ${JSON.stringify(content)}`);
    if (previousStatus === "settled") {
      assert.equal(
        status,
        "settled",
        `'a' regressed from settled back to ${status} at step: ${JSON.stringify(content)} — a settled word must never become risen again`
      );
    }
    previousStatus = status;
  }
  // By the time the list is proven complete, "a" must have actually
  // reached "settled" at some point during the sweep above (not stayed
  // "risen" forever, which would mean it never actually settled at all).
  assert.equal(previousStatus, "settled");
});

// Round 1's ordered-list numbering symptom, reappearing through the same
// bare-marker window: verified that a bare "3." does not itself get
// captured into a competing, separately-numbered list — and, decisively,
// that once the list is fully proven complete, it is ONE <ol> with three
// items, not two <ol> elements that never got reconciled.
test("ordered-list numbering stays correct through the bare-marker window, and settles as one <ol> once complete (fix round 3, finding 1)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);
  const orderedLists = () => findAllElements(container, (el) => el.tagName === "OL");
  const listItemCount = () => findAllElements(container, (el) => el.tagName === "LI").length;

  await setAssistantMessage("1. one\n\n2. two", true);
  await setAssistantMessage("1. one\n\n2. two\n\n3.", true);
  await setAssistantMessage("1. one\n\n2. two\n\n3. three", true);
  await setAssistantMessage("1. one\n\n2. two\n\n3. three\n\nAfter.", true);

  assert.equal(orderedLists().length, 1, "the fully-streamed list must be exactly one <ol>, never two left unreconciled");
  assert.equal(listItemCount(), 3);
  assert.match(container.textContent, /After\./);
});

// The floor's reset contract, exercised through the real component: a
// brand new reply (a different message id — see useChatStreaming.ts, which
// mints one crypto.randomUUID() per assistant turn and keeps reusing it for
// that turn's own updates) must not inherit a stale, larger floor left
// over from whatever a PREVIOUS reply settled to.
test("a new reply's own early words still rise — a previous reply's settled floor is not inherited (fix round 3, finding 1)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // First reply: settle a substantial prefix.
  await setAssistantMessage(
    "Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nStill going",
    true,
    "assistant-1"
  );
  const firstReplySettledLength = findSettledParagraph(container, "Paragraph one.") ? 1 : 0;
  assert.ok(firstReplySettledLength, "fixture-integrity check: expected the first reply to have settled content");

  // Second reply: a genuinely new message id, short content. If the floor
  // from the first reply (a much larger number) were wrongly inherited,
  // this short content would instantly render as fully "settled" (no live
  // tail at all — JS's slice semantics clamp an over-long end to the whole
  // string), so its own word would never get a chance to rise.
  await setAssistantMessage("Hi", true, "assistant-2");
  const hiSpan = riseSpans(container).find((span) => span.textContent === "Hi");
  assert.ok(
    hiSpan,
    "the new reply's own first word must be found risen — inheriting the old floor would settle it instantly instead"
  );
  assert.equal(
    findSettledParagraph(container, "Paragraph one."),
    null,
    "the previous reply's settled content must not still be present once a new reply has replaced it"
  );
});

// Fix round 3, finding 2: MarkdownRenderer.tsx built its react-markdown
// `components` map inline (a fresh object, with fresh arrow functions for
// every custom-mapped tag: p, li, h1-h3, ul, ol, code, pre, strong, em,
// blockquote) on every call. The tail is deliberately NOT wrapped in memo
// (only settled is — that's the actual mechanism behind this whole task's
// core guarantee), so every tail re-render handed react-markdown a
// brand-new `components` object. Since react-markdown uses each entry as
// the React element TYPE for its tag, a fresh object meant every
// custom-mapped ancestor got a NEW type reference on every render,
// forcing React to unmount and remount its entire subtree — including any
// already-risen word span inside it — regardless of round 1's sticky,
// byte-identical `risenWords` delay VALUE. A freshly (re)inserted DOM node
// with an `animation` declaration paints its "from" keyframe on/near its
// first paint (verified reasoning, not measured in a browser — none
// available here), so a word that had already finished rising would
// restart from opacity 0 every time a LATER word arrived in the SAME
// paragraph — not list-specific, not blockquote-specific: this is the
// common case, every multi-word paragraph, for the paragraph's whole
// streaming duration.
test("a tail word's DOM node survives a growth within the same paragraph (fix round 3, finding 2)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage("Echo foxtrot", true);
  const echoBefore = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.ok(echoBefore, "expected Echo to have risen on its first appearance");

  await setAssistantMessage("Echo foxtrot golf", true);
  const echoAfterOneGrowth = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.equal(
    echoAfterOneGrowth,
    echoBefore,
    "Echo's own DOM node must survive a tail growth in the same paragraph — a fresh node restarts its CSS animation from the 'from' keyframe regardless of the sticky delay value staying byte-identical"
  );

  await setAssistantMessage("Echo foxtrot golf hotel", true);
  const echoAfterTwoGrowths = riseSpans(container).find((span) => span.textContent === "Echo");
  assert.equal(echoAfterTwoGrowths, echoBefore, "still the same node after a second growth");
});

// Fix round 4 (Critical): useChatStreaming.ts always appends the next
// assistant message as {content: "", isStreaming: true} for its brand new id
// BEFORE the first chunk arrives (useChatStreaming.ts:369-372) — a guaranteed
// render on its own. The round-3 test above never drives that render (it
// jumps straight from reply 1 to setAssistantMessage("Hi", true,
// "assistant-2")), so it could not catch that on exactly that render,
// responseContent is "" (this message's own content) but displayedResponse
// still shows reply 1 through the deliberate empty-content fallback — and
// isStreamingNow is already true, so the old code wrote reply 1's settled
// boundary back as reply 2's floor, undoing the id-keyed reset on the very
// same render. Every render after that inherited the poisoned floor, since
// nothing ever un-poisons it once written.
const paragraphTexts = (container) =>
  findAllElements(container, (el) => el.tagName === "P").map((p) => p.textContent);

test("a new reply's first chunk still rises and the reply stays one paragraph, even through the guaranteed empty-content render that starts every follow-up turn (fix round 4)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // Reply 1: streams, then completes with a paragraph break — this is what
  // leaves a non-zero floor sitting in settledLengthRef when reply 2 starts.
  await setAssistantMessage(
    "Paragraph one.\n\nParagraph two.\n\nParagraph three.",
    true,
    "assistant-1"
  );
  await setAssistantMessage(
    "Paragraph one.\n\nParagraph two.\n\nParagraph three.",
    false,
    "assistant-1"
  );
  assert.ok(
    findSettledParagraph(container, "Paragraph three."),
    "fixture-integrity check: reply 1 must actually be showing before reply 2 starts"
  );

  // THE EMPTY-CONTENT RENDER: a brand new id, but useChatStreaming has not
  // delivered a single chunk yet. Driving this explicitly is the entire
  // point of this test.
  await setAssistantMessage("", true, "assistant-2");

  // First chunk of reply 2.
  await setAssistantMessage("Hello there", true, "assistant-2");
  const helloSpan = riseSpans(container).find((span) => span.textContent === "Hello");
  assert.ok(
    helloSpan,
    "the new reply's first word must rise — a floor poisoned by reply 1's boundary would settle 'Hello there' instantly instead (content.slice clamps past the string's end), skipping the tail/rise path entirely"
  );

  // Chunk 2 — this is exactly where the reviewer's measured trace showed the
  // reply splitting into two independently-parsed markdown documents: the
  // poisoned settled prefix ("Hello there") as one <p>, and the growing tail
  // as a second, separate <p>.
  await setAssistantMessage("Hello there friend, how are you today", true, "assistant-2");
  assert.deepEqual(
    paragraphTexts(container),
    ["Hello there friend, how are you today"],
    "the reply must still be ONE paragraph while streaming — a poisoned floor splits it into two independently-parsed markdown documents at the first chunk's character length"
  );

  // Chunk 3, then completion — the split (if present) never heals on its own.
  await setAssistantMessage(
    "Hello there friend, how are you today? I can help.",
    true,
    "assistant-2"
  );
  await setAssistantMessage(
    "Hello there friend, how are you today? I can help.",
    false,
    "assistant-2"
  );
  assert.deepEqual(paragraphTexts(container), ["Hello there friend, how are you today? I can help."]);
  assert.equal(
    findSettledParagraph(container, "Paragraph one."),
    null,
    "reply 1's content must not still be present once reply 2 has replaced it"
  );
});

// Neighbouring path (fix round 4): an aborted/errored stream's catch block
// finalizes the message's content as a (possibly multi-paragraph) error
// string with isStreaming: false (see useChatStreaming.ts's catch block) —
// structurally identical to a normal completed reply from AssistantPanel's
// point of view: non-empty content, isStreaming flips to false, same id
// throughout. The next user turn still mints a brand new id and still goes
// through the exact same guaranteed empty-content render, so this path is
// vulnerable to the identical staleness shape unless covered by the same
// fix — it is not a special case, just another "previous reply" shape.
test("a reply following an aborted/errored stream still rises its own first word (fix round 4, neighbouring path)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage(
    "Something went wrong.\n\nPlease try again in a moment.",
    true,
    "assistant-1"
  );
  await setAssistantMessage(
    "Something went wrong.\n\nPlease try again in a moment.",
    false, // the catch block always finalizes with isStreaming: false
    "assistant-1"
  );

  await setAssistantMessage("", true, "assistant-2"); // the empty-content render
  await setAssistantMessage("Sure, let me help", true, "assistant-2"); // first real chunk

  const sureSpan = riseSpans(container).find((span) => span.textContent === "Sure,");
  assert.ok(
    sureSpan,
    "a reply following an error must still rise its own first word — the error text is just another 'previous reply' shape the same floor-poisoning bug could latch onto"
  );
});

// Neighbouring path (fix round 4): AssistantPanel's own "New conversation"
// reset (handleNewConversation) is guarded by isBusy (it bails out while
// streaming.agentState/activeToolName/submissionInFlight say busy — see
// resolveAssistantPanelBusy), so it cannot fire mid-stream in the first
// place, and it synchronously empties `messages`, so latestAssistantMessage
// becomes undefined and isStreamingNow is false at the moment of reset —
// there is no in-flight streamed content for a floor to be poisoned FROM.
// This suite has no direct way to invoke handleNewConversation (it lives
// entirely inside the component and is wired to a footer button this
// harness's mocks do not render), so it is exercised here through the same
// observable state transition it performs: latestAssistantMessage flips
// from a settled reply straight to none while nothing is streaming.
test("clearing all messages outside of a stream (the shape of a new-conversation reset) leaves no floor to poison the next reply (fix round 4, neighbouring path)", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  await setAssistantMessage("Paragraph one.\n\nParagraph two.", true, "assistant-1");
  await setAssistantMessage("Paragraph one.\n\nParagraph two.", false, "assistant-1");

  // handleNewConversation's own reset shape: messages -> [], not streaming.
  await React.act(async () => {
    globalThis.__setStreamMessages([]);
  });

  await setAssistantMessage("Hi", true, "assistant-2");
  const hiSpan = riseSpans(container).find((span) => span.textContent === "Hi");
  assert.ok(hiSpan, "the new reply's own first word must still rise after a between-streams reset");
});
