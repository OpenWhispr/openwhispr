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

  const setAssistantMessage = async (content, isStreaming) => {
    await React.act(async () => {
      globalThis.__setStreamMessages([{ id: "assistant-1", role: "assistant", content, isStreaming }]);
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
  // genuinely changes. This must NOT be a no-op: proves the test can tell
  // the difference between "didn't re-render" and "nothing ever changes".
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia", true);
  const settledNodeAfterBoundary = findSettledParagraph(container, "Alpha bravo.");
  assert.notEqual(
    settledNodeAfterBoundary,
    settledNode,
    "once new text actually joins the settled portion, it legitimately re-renders once (this is not the case the guarantee protects)"
  );
  assert.ok(
    findSettledParagraph(container, "Echo foxtrot golf hotel."),
    "the paragraph that just settled should render as plain, non-animated text"
  );
  assert.equal(
    findSettledParagraph(container, "Echo foxtrot golf hotel.").getAttribute("data-rise"),
    null
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
