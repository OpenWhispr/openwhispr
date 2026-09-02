const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function findElements(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findElements(node.props?.children, predicate, matches);
  return matches;
}

// The action row is the only grid in this step's tree; its column count has to
// follow Skip, or Proceed sits half-width in the left column on its own.
function actionRowColumns(tree) {
  const [row] = findElements(
    tree,
    (node) =>
      typeof node.props?.className === "string" && node.props.className.includes("grid-cols")
  );
  return row.props.className.match(/grid-cols-\d/)[0];
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return textContent(node.props?.children);
}

test("local model rows distinguish downloading, selectable, and selected states", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  globalThis.__localModelSetupHarness = { cursor: 0, values: {}, downloadActive: false };
  t.after(() => {
    delete globalThis.__localModelSetupHarness;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-model-setup-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      react: `
        export function useState(initialValue) {
          const harness = globalThis.__localModelSetupHarness;
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
        export function useCallback(callback) { return callback; }
        export function useEffect() {}
        export function useMemo(factory) { return factory(); }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react-i18next": `
        export function useTranslation() { return { t(key) { return key; } }; }
      `,
      "lucide-react": `
        const Icon = () => null;
        export { Icon as AudioLines, Icon as Check, Icon as Circle, Icon as CircleCheck,
          Icon as Download, Icon as MousePointer2 };
      `,
      "/ProviderConnectionTest": `export default function ProviderConnectionTest() { return null; }`,
      "/ui/button": `export function Button() { return null; }`,
      "/ui/input": `export function Input() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      "/ui/select": `
        export function Select() { return null; }
        export function SelectContent() { return null; }
        export function SelectItem() { return null; }
        export function SelectTrigger() { return null; }
        export function SelectValue() { return null; }
      `,
      "/hooks/useModelDownload": `
        export function useModelDownload({ modelType }) {
          const harness = globalThis.__localModelSetupHarness;
          const active = modelType === "llm" && harness.downloadActive;
          return {
            isDownloading: active,
            isInstalling: false,
            isDownloadingModel(id) { return active && id === "qwen-9b"; },
            downloadProgress: { percentage: 20 },
            async downloadModel() {},
          };
        }
      `,
      "/stores/settingsStore": `
        const store = {
          chatAgentProvider: "qwen",
          localTranscriptionProvider: "whisper",
          setChatAgentMode() {}, setChatAgentProvider() {}, setChatAgentModel() {},
          setLocalTranscriptionProvider() {}, setParakeetModel() {}, setWhisperModel() {},
        };
        export function useSettingsStore() { return store; }
        useSettingsStore.getState = () => store;
      `,
      "/hooks/usePolicy": `export function usePolicySnapshot() { return {}; }`,
      "/stores/policyRules": `
        export function filterByokProviderOptionsByPolicy(values) { return values; }
        export function isModeAllowedByPolicy() { return true; }
        export function isProviderAllowedByPolicy() { return true; }
      `,
      "/models/ModelRegistry": `
        const models = [
          { id: "qwen-9b", name: "Qwen3.5 9B", size: "5.5GB" },
          { id: "qwen-4b", name: "Qwen3.5 4B", size: "2.7GB" },
        ];
        const provider = { id: "qwen", name: "Qwen", models };
        export const modelRegistry = {
          getProvider() { return provider; },
          getAllProviders() { return [provider]; },
          getCloudProviders() { return []; },
        };
        export function getTranscriptionProviders() { return []; }
        export function getParakeetModels() { return {}; }
        export function getWhisperModels() { return {}; }
        export function isCohereTranscribeModel() { return false; }
      `,
      "/pendingLocalModels": `
        export function forgetPendingLocalModel() {}
        export function readPendingLocalModels() { return {}; }
        export function rememberPendingLocalModel() {}
      `,
      "/localDownloadState": `
        export function isLocalStageDownloadActive(stage, activity) {
          return stage === "assistant" ? activity.llm : activity.whisper || activity.parakeet;
        }
      `,
    },
  });
  const { LocalModelSetupStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );
  const harness = globalThis.__localModelSetupHarness;
  const props = {
    stepId: "local-assistant",
    onReadinessChange() {},
    onProceed() {},
    onSkip() {},
  };
  const render = () => {
    harness.cursor = 0;
    return LocalModelSetupStep(props);
  };

  harness.values = {
    0: "qwen",
    1: "qwen-9b",
    2: new Set(),
    3: new Set(),
    4: new Set(["qwen-9b", "qwen-4b"]),
  };
  const selected = render();
  assert.match(textContent(selected), /onboarding\.rehaul\.local\.selected/);
  assert.match(textContent(selected), /onboarding\.rehaul\.local\.selectModel/);
  const selectedProceed = findElements(
    selected,
    (node) => node.type?.name === "StepPrimaryAction"
  )[0];
  assert.equal(selectedProceed.props.disabled, false);
  // Skip is the "don't wait for this download" escape hatch, so it stays off the
  // card whenever nothing is downloading.
  assert.equal(
    findElements(selected, (node) => node.type?.name === "StepSecondaryAction").length,
    0
  );
  assert.equal(actionRowColumns(selected), "grid-cols-1");

  harness.values = {
    0: "qwen",
    1: "",
    2: new Set(),
    3: new Set(),
    4: new Set(),
  };
  const idle = render();
  const idleProceed = findElements(idle, (node) => node.type?.name === "StepPrimaryAction")[0];
  assert.equal(idleProceed.props.disabled, true);
  // Neither action is available with no model on disk and no transfer running:
  // skipping here would finish onboarding on local transcription with nothing to
  // transcribe with. Back is the way out.
  assert.equal(findElements(idle, (node) => node.type?.name === "StepSecondaryAction").length, 0);
  assert.equal(actionRowColumns(idle), "grid-cols-1");

  harness.values = {
    0: "qwen",
    1: "",
    2: new Set(),
    3: new Set(),
    4: new Set(),
  };
  harness.downloadActive = true;
  const downloading = render();
  assert.match(textContent(downloading), /onboarding\.rehaul\.local\.downloadingShort/);
  assert.equal(findElements(downloading, (node) => node.props?.style?.width === "20%").length, 1);
  const downloadingProceed = findElements(
    downloading,
    (node) => node.type?.name === "StepPrimaryAction"
  )[0];
  assert.equal(downloadingProceed.props.disabled, true);
  assert.equal(
    findElements(downloading, (node) => node.type?.name === "StepSecondaryAction").length,
    1
  );
  assert.equal(actionRowColumns(downloading), "grid-cols-2");

  harness.values = {};
  harness.downloadActive = false;
  harness.cursor = 0;
  LocalModelSetupStep({
    ...props,
    resumeState: { provider: "qwen", modelId: "qwen-4b" },
  });
  assert.equal(harness.values[0], "qwen");
  assert.equal(harness.values[1], "qwen-4b");
});
