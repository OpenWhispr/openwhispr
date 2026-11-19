const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createInviteFlow, inviteReducer, inviteSummary } = require("../../src/lib/inviteFlow.ts");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts InvitePeopleView with the real Radix dropdown menu in happy-dom. The view tests mock the
// menu with a plain <button>, so they can't see Radix's own ids.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "HTMLInputElement",
  "ResizeObserver",
  "DOMRect",
];

let happyWindow;

test.before(async () => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  define("IS_REACT_ACT_ENVIRONMENT", true);
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function mountView(t, dispatch = () => {}, draft = "", stateOverrides = {}) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-invite-role-menu-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      // The view renders Dialog parts outside a Dialog root; only the dropdown stays real.
      "/ui/dialog": `
        import React from "react";
        const wrap = (tag) => ({ children }) => React.createElement(tag, null, children);
        export const DialogContent = wrap("div");
        export const DialogTitle = wrap("h2");
        export const DialogDescription = wrap("p");
      `,
    },
  });
  const { InvitePeopleView } = await vite.ssrLoadModule(
    "/components/workspace/InvitePeopleView.tsx"
  );

  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
  });

  await React.act(async () => {
    root.render(
      React.createElement(InvitePeopleView, {
        workspaceName: "Acme",
        state: {
          draft,
          recipients: [],
          role: "member",
          phase: "editing",
          sent: [],
          attached: [],
          attachInvited: false,
          memberEmails: [],
          invitedEmails: [],
          seats: { purchasedLeft: null, ceilingLeft: null },
          ...stateOverrides,
        },
        dispatch,
        suggestions: [],
        cancelLabel: "common.cancel",
        onCancel: () => {},
        onSend: () => {},
        onDone: () => {},
      })
    );
  });
  return happyWindow.document;
}

test("Done says an invitation was added to, not that one was sent", async (t) => {
  const document = await mountView(t, undefined, "", {
    phase: "done",
    attached: ["pat@acme.test"],
  });

  assert.equal(document.querySelector("h2")?.textContent, "workspaces.invite.attachedTitle");
  assert.match(document.body.textContent, /workspaces\.invite\.attachedBody/);
  assert.doesNotMatch(document.body.textContent, /workspaces\.invite\.sent/);
});

test("the role menu keeps Radix's trigger id so the open menu is named", async (t) => {
  const document = await mountView(t);

  const trigger = document.querySelector("button[aria-haspopup='menu']");
  assert.ok(trigger, "role trigger is rendered");

  // The trigger is named by the label plus the visible role, both of which exist.
  const [labelId, valueId] = trigger.getAttribute("aria-labelledby").split(" ");
  assert.ok(labelId && valueId, "aria-labelledby lists the label and the role value");
  assert.equal(document.getElementById(labelId)?.textContent, "workspaces.invite.roleLabel");
  assert.equal(document.getElementById(valueId)?.textContent, "workspaces.invite.role.member");
  assert.ok(trigger.contains(document.getElementById(valueId)), "the value is the trigger's text");

  // The trigger's own id is Radix's, not one of ours, so Radix's references to it still resolve.
  const triggerId = trigger.getAttribute("id");
  assert.ok(triggerId, "trigger has an id");
  assert.notEqual(triggerId, labelId);
  assert.notEqual(triggerId, valueId);

  await React.act(async () => {
    trigger.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  });

  const menu = document.querySelector("[role='menu']");
  assert.ok(menu, "the menu opens");
  assert.equal(trigger.getAttribute("id"), triggerId, "opening the menu doesn't change the id");
  const menuLabelId = menu.getAttribute("aria-labelledby");
  assert.ok(menuLabelId, "the open menu is labelled");
  assert.ok(document.getElementById(menuLabelId), "the menu's label resolves to an element");
});

test("Enter commits an address only after IME composition finishes", async (t) => {
  const events = [];
  const document = await mountView(t, (event) => events.push(event), "田中");
  const input = document.querySelector("input[role='combobox']");
  input.focus();

  for (const isComposing of [true, false]) {
    const enter = new happyWindow.KeyboardEvent("keydown", {
      key: "Enter",
      isComposing,
      bubbles: true,
      cancelable: true,
    });
    await React.act(async () => input.dispatchEvent(enter));

    assert.equal(enter.defaultPrevented, !isComposing);
    assert.deepEqual(events, isComposing ? [] : [{ type: "commit" }]);
  }
});

for (const [name, text, draft, start, end] of [
  ["LF", "Alpha Person <alpha@example.invalid>\nBeta Person <beta@example.invalid>", "", 0, 0],
  ["CRLF", "Alpha Person <alpha@example.invalid>\r\nBeta Person <beta@example.invalid>", "", 0, 0],
  [
    "selection",
    "Person <alpha@example.invalid>\nBeta",
    "Alpha OLD Person <beta@example.invalid>",
    6,
    9,
  ],
]) {
  test(`multiline paste preserves ${name} recipients at the input boundary`, async (t) => {
    const events = [];
    const document = await mountView(t, (event) => events.push(event), draft);
    const input = document.querySelector("input[role='combobox']");
    input.setSelectionRange(start, end);
    const clipboardData = new happyWindow.DataTransfer();
    clipboardData.setData("text/plain", text);
    const paste = new happyWindow.ClipboardEvent("paste", {
      clipboardData,
      bubbles: true,
      cancelable: true,
    });

    await React.act(async () => input.dispatchEvent(paste));

    assert.equal(paste.defaultPrevented, true);
    const state = events.reduce(inviteReducer, { ...createInviteFlow({}), draft });
    assert.deepEqual(
      state.recipients.map((recipient) => recipient.email),
      ["alpha@example.invalid", "beta@example.invalid"]
    );
    assert.equal(state.draft, "");
    assert.equal(inviteSummary(state).canSend, true);
  });
}

test("pressing Cancel leaves focus in the field", async (t) => {
  const document = await mountView(t);
  const cancel = [...document.querySelectorAll("button")].at(-1);
  const press = new happyWindow.Event("mousedown", { bubbles: true, cancelable: true });

  await React.act(async () => cancel.dispatchEvent(press));

  // Its blur would chip a half-typed address, and the error bar that raises moves the button out
  // from under the click.
  assert.equal(press.defaultPrevented, true);
});
