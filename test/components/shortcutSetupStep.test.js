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

async function createShortcutHarness(t, overrides = {}) {
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
    noExternal: ["react", "react-i18next"],
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
      "/components/icons": `
        export function Globe() { return null; }
        export function Loader2() { return null; }
      `,
      "/ui/HotkeyInput": `export function HotkeyInput() { return null; }`,
      "/utils/hotkeys": `export function formatHotkeyLabel(value) { return value; }`,
      "/hotkeyPresentation": `
        export function formatHotkeyInstruction(value) { return value.split("+").join(" + "); }
        export function formatRecommendedHotkey(value) {
          return value === "GLOBE" || value === "Fn"
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
    ...overrides,
  };
  const render = (renderOverrides = {}) => {
    harness.cursor = 0;
    return ShortcutSetupStep({ ...props, ...renderOverrides });
  };
  return {
    harness,
    render,
    input: (tree) => findElement(tree, (node) => node.type?.name === "HotkeyInput"),
    chord: (tree) => findElement(tree, (node) => node.type?.name === "HotkeyChord"),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const button = (tree, label) =>
  findElement(tree, (node) => node.type === "button" && textContent(node) === label);

test("the step opens empty and listening, with the recommendations as one-click picks", async (t) => {
  const { harness, render, chord } = await createShortcutHarness(t);

  const initialTree = render();
  assert.equal(chord(initialTree), null, "nothing is pre-filled");
  assert.match(textContent(initialTree), /Capture/);
  assert.match(textContent(initialTree), /RecommendedRight OptionGlobe\/FnCtrl \+ R/);
  assert.doesNotMatch(textContent(initialTree), /confirmAgain/);
  assert.equal(button(initialTree, "Choose another shortcut"), null);

  // A recommendation is registered on the click; no second press needed.
  button(initialTree, "Right Option").props.onClick();
  await settle();
  assert.deepEqual(harness.confirmed, ["RightOption"]);
  assert.deepEqual(harness.changed, ["RightOption"]);
  assert.equal(harness.cleared, 0);

  const confirmedTree = render();
  assert.equal(chord(confirmedTree).props.value, "RightOption");
  assert.doesNotMatch(textContent(confirmedTree), /Recommended|confirmAgain|Capture/);
  assert.ok(button(confirmedTree, "Choose another shortcut"));
});

test("a pressed key is confirmed by pressing it again, and can be swapped out", async (t) => {
  const { harness, render, input, chord } = await createShortcutHarness(t);

  input(render()).props.onChange("Control+Alt");
  assert.deepEqual(harness.confirmed, []);
  assert.equal(harness.cleared, 1, "a fresh capture supersedes whatever the caller held");

  const candidateTree = render();
  assert.equal(chord(candidateTree).props.value, "Control+Alt");
  assert.match(
    textContent(candidateTree),
    /onboarding\.rehaul\.hotkey\.confirmAgain:Control \+ Alt/
  );
  assert.doesNotMatch(textContent(candidateTree), /Recommended/);
  assert.ok(button(candidateTree, "Choose another shortcut"));

  // The caller's value never overrides a chord the user pressed.
  assert.equal(chord(render({ value: "Meta+J" })).props.value, "Control+Alt");

  input(candidateTree).props.onChange("Control+Alt");
  await settle();
  assert.deepEqual(harness.confirmed, ["Control+Alt"]);
  assert.deepEqual(harness.changed, ["Control+Alt"]);

  // Choosing another empties the box, tells the caller, and brings the picks back.
  button(render(), "Choose another shortcut").props.onClick();
  assert.equal(harness.cleared, 2);
  const emptyTree = render();
  assert.equal(chord(emptyTree), null);
  assert.match(textContent(emptyTree), /RecommendedRight OptionGlobe\/FnCtrl \+ R/);
});

test("a shortcut confirmed in an earlier session reopens confirmed", async (t) => {
  const { harness, render, input } = await createShortcutHarness(t, {
    value: "Control+Alt",
    initiallyConfirmed: true,
  });

  // Resuming onto this step must not ask for the chord again, and must not offer
  // alternatives to a choice the user already made.
  const resumedTree = render();
  assert.match(textContent(resumedTree), /Control \+ Alt/);
  assert.doesNotMatch(textContent(resumedTree), /Capture|confirmAgain|Recommended/);

  // Pressing it again is the user starting over, not re-confirming: the caller has
  // to drop the chord it holds before a new one can replace it.
  input(resumedTree).props.onChange("Control+Alt");
  await settle();
  assert.deepEqual(harness.confirmed, []);
  assert.equal(harness.cleared, 1);

  const recapturedTree = render();
  assert.match(
    textContent(recapturedTree),
    /onboarding\.rehaul\.hotkey\.confirmAgain:Control \+ Alt/
  );
  input(recapturedTree).props.onChange("Control+Alt");
  await settle();
  assert.deepEqual(harness.confirmed, ["Control+Alt"]);
  assert.deepEqual(harness.changed, ["Control+Alt"]);
});

test("a shortcut that fails to register empties the box and explains why", async (t) => {
  const { harness, render, chord } = await createShortcutHarness(t, {
    onConfirm: async () => "taken",
  });

  button(render(), "Ctrl + R").props.onClick();
  await settle();
  assert.deepEqual(harness.changed, []);
  assert.equal(harness.cleared, 1);

  const failedTree = render();
  assert.equal(chord(failedTree), null);
  assert.match(textContent(failedTree), /taken/);
  assert.match(textContent(failedTree), /Recommended/);
});
