const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountDialogFixture } = require("../lib/dialogMountFixture");

const en = require("../../src/locales/en/translation.json");
const translate = (dict, key) => key.split(".").reduce((s, k) => s?.[k], dict) ?? key;

test("real triggerless nested dialogs restore surviving invokers, fallback and overrides without stealing focus", async (t) => {
  globalThis.__dialogT = (key) => translate(en, key);
  t.after(() => {
    delete globalThis.__dialogT;
    delete globalThis.__dialogControls;
  });
  const { dom, container, render, vite, settle } = await mountDialogFixture(t, {
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({t: globalThis.__dialogT});`,
    },
  });
  const { Dialog, DialogContent, DialogTitle, ConfirmDialog, AlertDialog } =
    await vite.ssrLoadModule("/components/ui/dialog.tsx");
  let confirms = 0;
  function Owner() {
    const [parent, setParent] = React.useState(false);
    const [child, setChild] = React.useState(false);
    const [input, setInput] = React.useState(false);
    const [removed, setRemoved] = React.useState(false);
    const [disabled, setDisabled] = React.useState(false);
    const [override, setOverride] = React.useState(false);
    globalThis.__dialogControls = { setChild, setParent, setRemoved, setDisabled, setOverride };
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { id: "start", onClick: () => setParent(true) }, "Start"),
      React.createElement(
        Dialog,
        { open: parent, onOpenChange: setParent },
        React.createElement(
          DialogContent,
          null,
          React.createElement(DialogTitle, null, "Parent"),
          !removed &&
            React.createElement(
              "button",
              {
                id: "invoker",
                disabled,
                onClick: () => {
                  setInput(false);
                  setChild(true);
                },
              },
              "Confirm"
            ),
          React.createElement(
            "button",
            {
              id: "password",
              onClick: () => {
                setInput(true);
                setChild(true);
              },
            },
            "Password"
          ),
          React.createElement("button", { id: "handoff" }, "Handoff")
        )
      ),
      input
        ? React.createElement(
            Dialog,
            { open: child, onOpenChange: setChild },
            React.createElement(
              DialogContent,
              {
                onCloseAutoFocus: override
                  ? (event) => {
                      event.preventDefault();
                      dom.document.querySelector("#handoff").focus();
                    }
                  : undefined,
              },
              React.createElement(DialogTitle, null, "Password"),
              React.createElement("input", { autoFocus: true, "aria-label": "Password draft" })
            )
          )
        : React.createElement(ConfirmDialog, {
            open: child,
            onOpenChange: setChild,
            title: "Child",
            onConfirm: () => confirms++,
          })
    );
  }
  await render(React.createElement(React.StrictMode, null, React.createElement(Owner)));
  const start = container.querySelector("#start");
  await React.act(async () => {
    start.focus();
    start.click();
  });
  await settle();
  const invoker = () => dom.document.querySelector("#invoker");
  const open = async () => {
    await React.act(async () => {
      invoker().focus();
      invoker().click();
    });
    await settle();
    assert.equal(dom.document.activeElement.textContent, "Confirm");
  };
  for (const close of ["Cancel", "Confirm", "Close", "Escape"]) {
    await open();
    const dialogs = [...dom.document.querySelectorAll('[role="dialog"][data-state="open"]')];
    const child = dialogs.at(-1);
    await React.act(async () => {
      if (close === "Escape")
        dom.document.activeElement.dispatchEvent(
          new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      else
        [...child.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === close)
          .click();
    });
    await settle();
    assert.equal(dom.document.activeElement, invoker(), close);
    assert.equal(dom.document.querySelectorAll('[role="dialog"][data-state="open"]').length, 1);
  }
  assert.equal(confirms, 1);
  await open();
  await React.act(async () => {
    globalThis.__dialogControls.setDisabled(true);
    globalThis.__dialogControls.setChild(false);
  });
  await settle();
  assert.equal(
    dom.document.activeElement,
    invoker().closest('[role="dialog"]'),
    "a pending action's disabled invoker falls back to its parent dialog"
  );
  await React.act(async () => globalThis.__dialogControls.setDisabled(false));
  const password = dom.document.querySelector("#password");
  await React.act(async () => {
    password.focus();
    password.click();
  });
  await settle();
  assert.equal(dom.document.activeElement.getAttribute("aria-label"), "Password draft");
  await React.act(async () => globalThis.__dialogControls.setChild(false));
  await settle();
  assert.equal(
    dom.document.activeElement,
    password,
    "native input autofocus does not lose the invoker"
  );
  await open();
  await React.act(async () => globalThis.__dialogControls.setRemoved(true));
  await React.act(async () => globalThis.__dialogControls.setChild(false));
  await settle();
  assert.equal(
    dom.document.activeElement.getAttribute("role"),
    "dialog",
    "removed invoker falls back to surviving parent"
  );
  await React.act(async () => {
    globalThis.__dialogControls.setOverride(true);
    password.focus();
    password.click();
  });
  await settle();
  await React.act(async () => globalThis.__dialogControls.setChild(false));
  await settle();
  assert.equal(dom.document.activeElement.id, "handoff", "caller override wins");
  await React.act(async () => globalThis.__dialogControls.setParent(false));
  await settle();
  assert.equal(dom.document.activeElement, start);

  await render(
    React.createElement(AlertDialog, { open: true, onOpenChange() {}, title: "Alert", onOk() {} })
  );
  await settle();
  assert.ok(
    [...dom.document.querySelectorAll("button")].some((button) => button.textContent === "OK")
  );
  await render(
    React.createElement(ConfirmDialog, {
      open: true,
      onOpenChange() {},
      title: "Override",
      onConfirm() {},
      confirmText: "Supplied",
      cancelText: "Kept",
    })
  );
  assert.ok(
    [...dom.document.querySelectorAll("button")].some((button) => button.textContent === "Supplied")
  );
  assert.ok(
    [...dom.document.querySelectorAll("button")].some((button) => button.textContent === "Kept")
  );
});
