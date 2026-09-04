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

function findByName(tree, name) {
  return findElements(tree, (node) => node.type?.name === name);
}

// Rows are keyed by model id, so a per-model assertion can read just that row
// rather than the whole card.
function modelRow(tree, modelId) {
  const [row] = findElements(tree, (node) => node.key === modelId);
  assert.ok(row, `expected a row for ${modelId}`);
  return row;
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

test("local model setup reflects what is on disk, downloading, and resumed", async (t) => {
  const harness = {
    cursor: 0,
    slots: {},
    effects: [],
    downloadedLlm: [],
    downloadActive: false,
    savedChatAgentModel: "",
  };
  globalThis.__localModelSetupHarness = harness;
  t.after(() => {
    delete globalThis.__localModelSetupHarness;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        // Assistant models come from modelGetAll; the two transcription lists are
        // queried on the same pass and stay empty for a local-assistant step.
        modelGetAll: async () =>
          globalThis.__localModelSetupHarness.downloadedLlm.map((id) => ({
            id,
            isDownloaded: true,
          })),
        listWhisperModels: async () => ({ models: [] }),
        listParakeetModels: async () => ({ models: [] }),
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-model-setup-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      // A minimal renderer rather than react-dom: it returns the element tree so
      // the assertions can read rendered output, and it runs effects so the
      // downloaded-model state comes from window.electronAPI the way it does in
      // the app. Nothing here is keyed on hook call order.
      react: `
        export function useState(initialValue) {
          const harness = globalThis.__localModelSetupHarness;
          const slot = harness.cursor++;
          if (!(slot in harness.slots)) {
            harness.slots[slot] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.slots[slot], (nextValue) => {
            harness.slots[slot] = typeof nextValue === "function"
              ? nextValue(harness.slots[slot])
              : nextValue;
          }];
        }
        export function useCallback(callback) { return callback; }
        export function useMemo(factory) { return factory(); }
        export function useEffect(effect) {
          globalThis.__localModelSetupHarness.effects.push(effect);
        }
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
      "/hooks/useDebouncedCallback": `
        export function useDebouncedCallback(callback) { return callback; }
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
          get chatAgentModel() {
            return globalThis.__localModelSetupHarness.savedChatAgentModel;
          },
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

  const baseProps = {
    stepId: "local-assistant",
    onReadinessChange() {},
    onProceed() {},
    onSkip() {},
    onResumeStateChange() {},
  };

  // Renders, runs the queued effects, lets their promises settle, and renders
  // again — so the tree under assertion is the one the user ends up looking at
  // once the disk check has come back.
  const renderSettled = async (props = {}) => {
    harness.slots = {};
    let tree = null;
    for (let pass = 0; pass < 3; pass += 1) {
      harness.cursor = 0;
      harness.effects = [];
      tree = LocalModelSetupStep({ ...baseProps, ...props });
      for (const effect of harness.effects) effect();
      await new Promise((resolve) => setImmediate(resolve));
    }
    return tree;
  };

  // Both models on disk, the saved one active: it shows Selected, the other
  // offers Select model, and Proceed is available.
  harness.downloadedLlm = ["qwen-9b", "qwen-4b"];
  harness.savedChatAgentModel = "qwen-9b";
  harness.downloadActive = false;
  const selected = await renderSettled();
  assert.match(textContent(modelRow(selected, "qwen-9b")), /onboarding\.rehaul\.local\.selected/);
  assert.match(
    textContent(modelRow(selected, "qwen-4b")),
    /onboarding\.rehaul\.local\.selectModel/
  );
  assert.equal(findByName(selected, "StepPrimaryAction")[0].props.disabled, false);
  // Skip is the "don't wait for this download" escape hatch, so it stays off the
  // card whenever nothing is downloading.
  assert.equal(findByName(selected, "StepSecondaryAction").length, 0);
  assert.equal(actionRowColumns(selected), "grid-cols-1");

  // Nothing on disk: every row offers Download and Proceed is withheld.
  harness.downloadedLlm = [];
  harness.savedChatAgentModel = "";
  const idle = await renderSettled();
  assert.match(textContent(modelRow(idle, "qwen-9b")), /onboarding\.rehaul\.local\.download/);
  assert.doesNotMatch(textContent(idle), /onboarding\.rehaul\.local\.selected/);
  assert.equal(findByName(idle, "StepPrimaryAction")[0].props.disabled, true);
  // Neither action is available with no model on disk and no transfer running:
  // skipping here would finish onboarding on local transcription with nothing to
  // transcribe with. Back is the way out.
  assert.equal(findByName(idle, "StepSecondaryAction").length, 0);
  assert.equal(actionRowColumns(idle), "grid-cols-1");

  // Mid-download: the row shows progress, Proceed stays withheld, and Skip
  // appears as the way past a transfer the user should not have to wait for.
  harness.downloadActive = true;
  const downloading = await renderSettled();
  const downloadingRow = modelRow(downloading, "qwen-9b");
  assert.match(textContent(downloadingRow), /onboarding\.rehaul\.local\.downloadingShort/);
  assert.equal(
    findElements(downloadingRow, (node) => node.props?.style?.width === "20%").length,
    1
  );
  assert.equal(findByName(downloading, "StepPrimaryAction")[0].props.disabled, true);
  assert.equal(findByName(downloading, "StepSecondaryAction").length, 1);
  assert.equal(actionRowColumns(downloading), "grid-cols-2");

  // A resumed draft outranks the model the store has saved, so the step reopens
  // on the row the user last picked.
  harness.downloadedLlm = ["qwen-9b", "qwen-4b"];
  harness.savedChatAgentModel = "qwen-9b";
  harness.downloadActive = false;
  const resumed = await renderSettled({ resumeState: { provider: "qwen", modelId: "qwen-4b" } });
  assert.match(textContent(modelRow(resumed, "qwen-4b")), /onboarding\.rehaul\.local\.selected/);
  assert.match(textContent(modelRow(resumed, "qwen-9b")), /onboarding\.rehaul\.local\.selectModel/);
});
