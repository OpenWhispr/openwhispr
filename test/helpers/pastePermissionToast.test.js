const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");
const translations = require("../../src/locales/en/translation.json");
const click = (button) => button.dispatchEvent({ type: "click", bubbles: true, button: 0 });

async function setup(t, mockModules = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__recoveryCardProps;
  });
  installBrowserGlobals(t, { window: { location: { search: "", pathname: "/" } } });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-recovery-card-",
    mockModules,
  });
  const [{ default: i18n }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  });
  root = createRoot(container);
  return {
    container,
    vite,
    render: async (element) => React.act(async () => root.render(element)),
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("permission toasts persist through actions and compose close with provider dismissal", async (t) => {
  const h = await setup(t, {
    "/dictation/DictationErrorCard": `export function DictationErrorCard(props) { globalThis.__recoveryCardProps=props; return null; }`,
  });
  const { ToastProvider } = await h.vite.ssrLoadModule("/components/ui/Toast.tsx");
  const { useToast } = await h.vite.ssrLoadModule("/components/ui/useToast.ts");
  let context;
  function Probe() {
    context = useToast();
    return null;
  }
  await h.render(React.createElement(ToastProvider, null, React.createElement(Probe)));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  for (const title of ["Permission needed", "Settings could not open"]) {
    await React.act(async () =>
      context.toast({
        title,
        presentation: "dictation-error",
        duration: 0,
        dismissible: true,
        onClose: () => events.push("closed"),
        actions: [
          {
            label: "Settings",
            dismissOnClick: false,
            onClick: async () => events.push("settings"),
          },
          { label: "Copy", dismissOnClick: false, onClick: async () => true },
        ],
      })
    );
    let card = globalThis.__recoveryCardProps;
    assert.equal(card.progressDuration, 0);
    await React.act(async () => card.onAction(card.actions[0]));
    assert.equal(await card.onAction(card.actions[1]), true, "Toast forwards Copy result");
    await React.act(async () => t.mock.timers.tick(60001));
    assert.equal(context.toastCount, 1);
    card = globalThis.__recoveryCardProps;
    assert.equal(typeof card.onDismiss, "function");
    await React.act(async () => card.onDismiss());
    await React.act(async () => t.mock.timers.tick(201));
    assert.equal(context.toastCount, 0);
  }
  assert.deepEqual(events, ["settings", "closed", "settings", "closed"]);
  await React.act(async () =>
    context.toast({ title: "Short", presentation: "dictation-error", actions: [] })
  );
  assert.equal(globalThis.__recoveryCardProps.onDismiss, undefined);
  await React.act(async () => t.mock.timers.tick(3001));
  await React.act(async () => t.mock.timers.tick(201));
  assert.equal(context.toastCount, 0, "generic timer unchanged");
  await React.act(async () =>
    context.toast({
      title: "Transcript",
      presentation: "dictation-error",
      onClose: () => events.push("before"),
      actions: [{ label: "View transcript", onClick: () => events.push("view") }],
    })
  );
  const card = globalThis.__recoveryCardProps;
  await React.act(async () => card.onAction(card.actions[0]));
  assert.deepEqual(events.slice(-2), ["before", "view"]);
});

test("real card keeps copy local, guards pending clicks, resets feedback and renders shortcut keycaps", async (t) => {
  const h = await setup(t);
  const { DictationErrorCard } = await h.vite.ssrLoadModule(
    "/components/dictation/DictationErrorCard.tsx"
  );
  let resolveCopy,
    calls = 0,
    closed = 0;
  const action = {
    label: "Copy to clipboard",
    icon: "copy",
    dismissOnClick: false,
    feedback: { successLabel: "Copied", failureLabel: "Copy failed" },
    onClick: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveCopy = resolve;
      });
    },
  };
  const props = {
    title: "Allow automatic pasting",
    description: "Paste with Cmd+V.",
    descriptionHotkey: "Cmd+V",
    actions: [action],
    onAction: (value) => value.onClick(),
    onDismiss: () => {
      closed += 1;
    },
  };
  await h.render(React.createElement(DictationErrorCard, props));
  const getCopy = () =>
    findElement(
      h.container,
      (e) =>
        e.tagName === "BUTTON" && e.textContent !== "" && e.getAttribute("aria-label") !== "Close"
    );
  assert.ok(findElement(h.container, (e) => e.tagName === "KBD" && e.textContent === "⌘"));
  assert.ok(findElement(h.container, (e) => e.tagName === "KBD" && e.textContent === "V"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [result, label] of [
    [true, "Copied"],
    [false, "Copy failed"],
    [undefined, "Copy to clipboard"],
  ]) {
    const previousCalls = calls;
    await React.act(async () => {
      click(getCopy());
      click(getCopy());
    });
    assert.equal(calls, previousCalls + 1);
    assert.notEqual(getCopy().getAttribute("disabled"), null);
    await React.act(async () => resolveCopy(result));
    assert.equal(getCopy().textContent.trim(), label);
    assert.equal(closed, 0);
    await React.act(async () => t.mock.timers.tick(1801));
    assert.equal(getCopy().textContent.trim(), "Copy to clipboard");
  }
  action.onClick = async () => {
    throw new Error("copy rejected");
  };
  await React.act(async () => click(getCopy()));
  assert.equal(getCopy().textContent.trim(), "Copy failed");
  action.onClick = () =>
    new Promise((resolve) => {
      resolveCopy = resolve;
    });
  await React.act(async () => click(getCopy()));
  const oldCopy = resolveCopy;
  await h.render(React.createElement(DictationErrorCard, { ...props, key: "new card" }));
  await React.act(async () => oldCopy(true));
  assert.equal(
    getCopy().textContent.trim(),
    "Copy to clipboard",
    "old results do not affect a new card"
  );
  const closeButton = findElement(h.container, (e) => e.getAttribute("aria-label") === "Close");
  assert.ok(closeButton);
  await React.act(async () => click(closeButton));
  assert.equal(closed, 1);
  await React.act(async () => click(getCopy()));
  await h.unmount();
  await React.act(async () => resolveCopy(true));
  await React.act(async () => t.mock.timers.tick(1801));
  assert.equal(h.container.textContent, "");
});
