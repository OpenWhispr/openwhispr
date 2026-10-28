const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
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

async function mountView(t) {
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
          draft: "",
          recipients: [],
          role: "member",
          phase: "editing",
          sent: [],
          memberEmails: [],
          invitedEmails: [],
        },
        dispatch: () => {},
        suggestions: [],
        seatLine: null,
        seatCostLine: null,
        cancelLabel: "common.cancel",
        onCancel: () => {},
        onSend: () => {},
        onDone: () => {},
      })
    );
  });
  return happyWindow.document;
}

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
