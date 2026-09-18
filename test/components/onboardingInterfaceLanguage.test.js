const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer } = require("../lib/rendererTestHarness");

const load = () => import("../../src/config/uiLanguages.ts");

test("onboarding offers every supported interface language once", async () => {
  const { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_OPTIONS } = await load();
  const values = UI_LANGUAGE_OPTIONS.map(({ value }) => value);

  assert.deepEqual(values, [...SUPPORTED_UI_LANGUAGES]);
  assert.equal(new Set(values).size, values.length);
});

test("interface language labels are native and distinct from transcription choices", async () => {
  const { UI_LANGUAGE_OPTIONS } = await load();
  const options = new Map(UI_LANGUAGE_OPTIONS.map((option) => [option.value, option]));

  assert.equal(options.get("zh-CN").label, "简体中文");
  assert.equal(options.get("zh-TW").label, "繁體中文");
  assert.equal(options.has("auto"), false);
  assert.equal(options.has("en-US"), false);
});

function findElements(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findElements(child, predicate, matches));
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findElements(node.props?.children, predicate, matches);
  return matches;
}

test("selecting a native radio reports its supported UI locale", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-interface-language-step-",
    noExternal: ["react"],
    mockModules: {
      react: `export function useId() { return "interface-language"; }`,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "./OnboardingList": `export default function OnboardingList() { return null; }`,
      "../icons": `export function Check() { return null; }`,
    },
  });
  const { default: InterfaceLanguageStep } = await vite.ssrLoadModule(
    "/components/onboarding/InterfaceLanguageStep.tsx"
  );

  let selected = null;
  const tree = InterfaceLanguageStep({
    value: "en",
    onChange: (language) => {
      selected = language;
    },
    label: "Interface language",
  });
  const radios = findElements(
    tree,
    (node) => node.type === "input" && node.props?.type === "radio"
  );
  const zhTw = radios.find((radio) => radio.props.value === "zh-TW");

  assert.ok(zhTw);
  assert.equal(
    radios.every((radio) => radio.props.name === "interface-language"),
    true
  );
  zhTw.props.onChange();
  assert.equal(selected, "zh-TW");
  assert.equal(
    findElements(
      tree,
      (node) => node.type === "label" && node.props?.className?.includes("text-start")
    ).length,
    radios.length
  );
});
