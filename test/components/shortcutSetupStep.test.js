const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer } = require("../lib/rendererTestHarness");

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return textContent(node.props?.children);
}

test("shortcut selection requires the same chord twice and keeps confirmation keyboard-driven", async (t) => {
  globalThis.__shortcutSetupHarness = {
    cursor: 0,
    values: {},
    confirmed: [],
    changed: [],
    cleared: 0,
  };
  t.after(() => {
    delete globalThis.__shortcutSetupHarness;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-shortcut-setup-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      react: `
        export function useState(initialValue) {
          const harness = globalThis.__shortcutSetupHarness;
          const index = harness.cursor++;
          if (!(index in harness.values)) {
            harness.values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.values[index], (nextValue) => {
            harness.values[index] = typeof nextValue === "function"
              ? nextValue(harness.values[index])
              : nextValue;
          }];
        }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react-i18next": `
        export function useTranslation() {
          return { t(key, options) { return options?.hotkey ? key + ":" + options.hotkey : key; } };
        }
      `,
      "lucide-react": `
        export function Globe() { return null; }
        export function Loader2() { return null; }
      `,
      "/ui/HotkeyInput": `export function HotkeyInput() { return null; }`,
      "/utils/hotkeys": `export function formatHotkeyLabel(value) { return value; }`,
      "/hotkeyPresentation": `
        export function formatHotkeyInstruction(value) { return value.split("+").join(" + "); }
        export function formatRecommendedHotkey(value) {
          return value === "GLOBE"
            ? "Globe/Fn"
            : value.replace("RightOption", "Right Option").replace(/^Control/, "Ctrl").split("+").join(" + ");
        }
        export function getHotkeyKeycaps(value) {
          return value.split("+").filter(Boolean).map((part, index) => ({
            id: part + "-" + index,
            label: part.toLowerCase(),
            symbol: part.slice(0, 1),
          }));
        }
      `,
    },
  });
  const { default: ShortcutSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ShortcutSetupStep.tsx"
  );
  const harness = globalThis.__shortcutSetupHarness;
  const props = {
    value: "RightOption",
    initiallyConfirmed: false,
    recommended: ["RightOption", "GLOBE", "Control+R"],
    captureLabel: "Capture",
    recommendedLabel: "Recommended",
    chooseAnotherLabel: "Choose another shortcut",
    dense: true,
    onConfirm: async (value) => {
      harness.confirmed.push(value);
      return null;
    },
    onChange: (value) => harness.changed.push(value),
    onClearSelection: () => {
      harness.cleared += 1;
    },
  };
  const render = () => {
    harness.cursor = 0;
    return ShortcutSetupStep(props);
  };
  const input = (tree) => findElement(tree, (node) => node.type?.name === "HotkeyInput");

  // The step opens with the recommended chord already in the box, so it asks for a
  // first press; "press it again" only applies once a chord has actually been captured.
  const initialTree = render();
  assert.match(textContent(initialTree), /Capture/);
  assert.doesNotMatch(textContent(initialTree), /confirmAgain/);
  assert.ok(
    findElement(
      initialTree,
      (node) => node.type === "button" && textContent(node) === "Choose another shortcut"
    ),
    "an unconfirmed shortcut should still expose the reset action"
  );
  input(initialTree).props.onChange("RightOption");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.confirmed, ["RightOption"]);
  assert.deepEqual(harness.changed, ["RightOption"]);

  const confirmedTree = render();
  const chooseAnother = findElement(
    confirmedTree,
    (node) => node.type === "button" && textContent(node) === "Choose another shortcut"
  );
  assert.ok(chooseAnother);
  chooseAnother.props.onClick();
  harness.confirmed.length = 0;
  harness.changed.length = 0;

  const emptyTree = render();
  assert.match(textContent(emptyTree), /RecommendedRight OptionGlobe\/FnCtrl \+ R/);

  input(emptyTree).props.onChange("Control+Alt");
  assert.deepEqual(harness.confirmed, []);
  assert.deepEqual(harness.changed, []);

  const candidateTree = render();
  assert.match(
    textContent(candidateTree),
    /onboarding\.rehaul\.hotkey\.confirmAgain:Control \+ Alt/
  );
  assert.equal(
    findElement(
      candidateTree,
      (node) => node.type === "button" && /confirm/i.test(textContent(node))
    ),
    null
  );

  input(candidateTree).props.onChange("Control+Alt");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.confirmed, ["Control+Alt"]);
  assert.deepEqual(harness.changed, ["Control+Alt"]);
});
