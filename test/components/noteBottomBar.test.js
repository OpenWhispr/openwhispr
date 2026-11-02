const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Assertions are class-based, so the untranslated i18n fallback (raw keys) is fine.
async function renderBottomBar(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-bottom-bar-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `
        export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });
      `,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NoteBottomBar.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      isRecording: false,
      draftText: "",
      onDraftChange: () => {},
      onAskSubmit: () => {},
      ...props,
    })
  );
}

test("recording state renders no backdrop-filter surface over the live transcript", async (t) => {
  const html = await renderBottomBar(t, { isRecording: true });

  // The 1.9.0 CPU regression: every transcript partial re-blurred the strip.
  assert.ok(!html.includes("backdrop-blur"), "no backdrop-blur while recording");
  assert.ok(!html.includes("backdrop-saturate"), "no backdrop-saturate while recording");
  assert.ok(html.includes("bg-surface-2/95"), "capsules use the near-opaque surface");
  assert.ok(html.includes("shadow-(--shadow-glass)"), "capsules keep the glass rim shadow");
});

test("the bar and the open chat never blur the note behind them", async (t) => {
  for (const chatOpen of [false, true]) {
    const html = await renderBottomBar(t, { chatOpen });
    assert.ok(
      !/backdrop-|blur-\[/.test(html),
      `no blur with the chat ${chatOpen ? "open" : "closed"}`
    );
  }
});

test("in-view chat expands the existing capsule around one composer", async (t) => {
  const html = await renderBottomBar(t, { chatOpen: true });

  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
});

test("the collapsed composer offers the action picker; the chips wait for the chat to open", async (t) => {
  const props = {
    actionPicker: createElement("button", null, "Action picker"),
    actionChips: createElement("button", null, "All actions"),
    callout: createElement("button", null, "Generate summary"),
  };
  const closed = await renderBottomBar(t, { ...props, chatOpen: false });

  assert.ok(closed.includes("Generate summary"));
  assert.ok(!closed.includes("All actions"), "no chips over a collapsed composer");
  assert.ok(
    closed.indexOf("<textarea") < closed.indexOf("Action picker"),
    "the picker sits in the composer"
  );
  assert.ok(!closed.includes("agentMode.input.send"), "in place of the send button");

  const open = await renderBottomBar(t, { ...props, chatOpen: true });
  assert.ok(!open.includes("Action picker"), "the picker steps aside once the chat opens");
  assert.equal(open.split("All actions").length, 2, "the chips show once");
  assert.ok(open.indexOf("All actions") < open.indexOf("<textarea"), "above the composer");
});

// The real DOM pieces the open chat needs: containment, pointer events, ResizeObserver.
async function installHappyDom(t) {
  const { Window } = await import("happy-dom");
  const happyWindow = new Window();
  const fromWindow = [
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "PointerEvent",
    "MouseEvent",
    "FocusEvent",
    "ResizeObserver",
    "MutationObserver",
    "getComputedStyle",
  ];
  const names = [
    "window",
    ...fromWindow,
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of fromWindow) define(name, happyWindow[name]);
  define("requestAnimationFrame", happyWindow.requestAnimationFrame.bind(happyWindow));
  define("cancelAnimationFrame", happyWindow.cancelAnimationFrame.bind(happyWindow));
  define("IS_REACT_ACT_ENVIRONMENT", true);
  t.after(async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await happyWindow.happyDOM.close();
  });
  return happyWindow;
}

test("a click outside or an Esc closes the open chat, unless it dismisses a menu over the page", async (t) => {
  const { document, PointerEvent, MouseEvent, KeyboardEvent } = await installHappyDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-bottom-bar-outside-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `
        export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });
      `,
    },
  });
  const NoteBottomBar = (await vite.ssrLoadModule("/components/notes/NoteBottomBar.tsx")).default;
  const { createRoot } = require("react-dom/client");
  const { act } = require("react");

  const outside = document.createElement("p");
  const host = document.createElement("div");
  document.body.append(outside, host);
  const root = createRoot(host);
  let closed = 0;
  let escaped = 0;
  const render = (chatOpen) =>
    act(async () =>
      root.render(
        createElement(NoteBottomBar, {
          isRecording: false,
          draftText: "",
          onDraftChange: () => {},
          onAskSubmit: () => {},
          chatOpen,
          actionChips: createElement("button", { id: "in-chat" }, "Chip"),
          onClickOutside: () => closed++,
          onInputEscape: () => escaped++,
        })
      )
    );
  const press = (target) =>
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  const click = (target) => {
    press(target);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
  };

  await render(true);
  click(document.getElementById("in-chat"));
  assert.equal(closed, 0, "a click inside the chat keeps it open");
  click(document.querySelector("[data-note-chat-panel]").previousElementSibling);
  assert.equal(closed, 0, "as does one on the card's margin around it");
  press(outside);
  assert.equal(
    closed,
    0,
    "a press that never clicks (a touch scroll, a right-click) keeps it open"
  );
  document
    .getElementById("in-chat")
    .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 0 }));
  assert.equal(closed, 0, "nor does that stale press count for a later click from the keyboard");

  const menu = document.createElement("div");
  menu.setAttribute("data-radix-popper-content-wrapper", "");
  document.body.append(menu);
  press(outside);
  // Radix closes the menu on the press, before the click arrives.
  menu.remove();
  outside.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
  assert.equal(closed, 0, "a click that dismisses a menu over the page only closes the menu");

  press(outside);
  outside.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true, detail: 1, clientX: 40 })
  );
  assert.equal(closed, 0, "a drag that selects the note's text keeps it open");

  click(outside);
  assert.equal(closed, 1);

  const pressEscape = () =>
    document
      .getElementById("in-chat")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
  // Radix closes a menu on a capturing document listener and prevents the key's default.
  const closeMenu = (event) => event.preventDefault();
  document.addEventListener("keydown", closeMenu, true);
  pressEscape();
  document.removeEventListener("keydown", closeMenu, true);
  assert.equal(escaped, 0, "an Esc that closes a menu over the chat only closes the menu");
  // The note clears a transcript selection on any Esc that reaches the page.
  let reachedPage = 0;
  const countPageEscape = () => reachedPage++;
  document.addEventListener("keydown", countPageEscape);
  pressEscape();
  document.removeEventListener("keydown", countPageEscape);
  assert.equal(escaped, 1, "Esc closes the chat from anywhere in it, not just the composer");
  assert.equal(reachedPage, 0, "and goes no further");

  await render(false);
  click(outside);
  assert.equal(closed, 1, "a closed chat doesn't listen");
  await act(async () => root.unmount());
});
