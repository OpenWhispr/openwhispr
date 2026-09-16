const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    return node.map((child) => findElement(child, predicate)).find(Boolean) ?? null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  return node && typeof node === "object" ? textContent(node.props?.children) : "";
}

async function mountShortcut(t, overrides = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listening = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        setHotkeyListeningMode: (enabled) => listening.push(enabled),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-shortcut-lifecycle-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
    },
  });
  const { default: ShortcutSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ShortcutSetupStep.tsx"
  );
  const { getValidationMessage } = await vite.ssrLoadModule("/utils/hotkeyValidator.ts");
  const changed = [];
  const confirmed = [];
  let tree;
  let input;
  let inputTree;
  const props = {
    value: "RightOption",
    initiallyConfirmed: true,
    recommended: ["RightOption", "GLOBE", "Control+R"],
    captureLabel: "Capture",
    recommendedLabel: "Recommended",
    chooseAnotherLabel: "Choose another shortcut",
    validate: (value) => getValidationMessage(value, "darwin"),
    onConfirm: async (value) => {
      confirmed.push(value);
      return null;
    },
    onChange: (value) => changed.push(value),
    ...overrides,
  };

  function InputHarness({ element }) {
    // Run the real input handlers and effects with React lifecycle. Native DOM
    // focus and OS event delivery are outside this harness's boundary.
    inputTree = element.type(element.props);
    return null;
  }
  function Harness() {
    tree = ShortcutSetupStep(props);
    input = findElement(tree, (element) => element.type?.name === "HotkeyInput");
    return input ? React.createElement(InputHarness, { key: input.key, element: input }) : null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  return {
    changed,
    confirmed,
    listening,
    tree: () => tree,
    input: () => input,
    inputTree: () => (input ? inputTree : null),
    chord: () => findElement(tree, (element) => element.type?.name === "HotkeyChord"),
    button: (label) =>
      findElement(tree, (element) => element.type === "button" && textContent(element) === label),
  };
}

function keyboardEvent(key, code, modifiers = {}) {
  return {
    key,
    code,
    nativeEvent: { key, code, ...modifiers },
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
}

test("a confirmed shortcut keeps its keycaps when modifiers are pressed", async (t) => {
  const harness = await mountShortcut(t);
  await React.act(async () =>
    harness.inputTree()?.props.onKeyDown?.(keyboardEvent("Shift", "ShiftLeft", { shiftKey: true }))
  );

  assert.equal(harness.chord().props.value, "RightOption");
  assert.deepEqual(harness.changed, []);
  assert.deepEqual(harness.confirmed, []);
});

test("Tab navigates away from a confirmed shortcut without capturing a replacement", async (t) => {
  const harness = await mountShortcut(t);
  const event = keyboardEvent("Tab", "Tab");
  await React.act(async () => harness.inputTree()?.props.onKeyDown?.(event));

  assert.equal(event.defaultPrevented, false, "Tab must remain available for navigation");
  assert.equal(harness.chord().props.value, "RightOption");
  assert.deepEqual(harness.changed, []);
  assert.deepEqual(harness.confirmed, []);
});

test("choosing another shortcut restores capture and confirms the newly pressed chord", async (t) => {
  const harness = await mountShortcut(t);
  await React.act(async () => harness.button("Choose another shortcut").props.onClick());
  assert.ok(harness.inputTree(), "explicitly changing the shortcut mounts capture again");

  await React.act(async () =>
    harness.inputTree().props.onKeyDown(keyboardEvent("k", "KeyK", { ctrlKey: true }))
  );

  assert.deepEqual(harness.confirmed, ["Control+K"]);
  assert.deepEqual(harness.changed, ["Control+K"]);
  assert.equal(harness.chord().props.value, "Control+K");
  assert.equal(harness.inputTree(), null, "the confirmed chord stops capturing");
});

test("a rejected shortcut confirmation exits busy state and lets the user try again", async (t) => {
  let attempts = 0;
  const harness = await mountShortcut(t, {
    initiallyConfirmed: false,
    onConfirm: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Shortcut capability check failed");
      return null;
    },
  });
  await React.act(async () => {
    harness.button("Right Option").props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(harness.input().props.disabled, false);
  const alert = findElement(harness.tree(), (element) => element.props?.role === "alert");
  assert.equal(textContent(alert), "hooks.hotkeyRegistration.errors.failedToRegister");
  assert.deepEqual(harness.changed, []);

  await React.act(async () => harness.button("Right Option").props.onClick());
  assert.equal(attempts, 2);
  assert.equal(harness.chord().props.value, "RightOption");
  assert.equal(harness.inputTree(), null);
  assert.deepEqual(harness.changed, ["RightOption"]);
});
