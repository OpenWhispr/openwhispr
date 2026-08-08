const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findRunButton(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findRunButton(child);
      if (match) return match;
    }
    return null;
  }
  if (node.props?.className === "w-full" && typeof node.props.onClick === "function") return node;
  return findRunButton(node.props?.children);
}

test("Prompt Studio labels dictation-agent runs for policy enforcement", async (t) => {
  const calls = [];
  globalThis.__promptStudioReasoningCalls = calls;

  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-prompt-studio-test-"));
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: true },
    plugins: [
      {
        name: "prompt-studio-agent-policy-dependencies",
        enforce: "pre",
        resolveId(source) {
          const modules = {
            react: "react",
            "react/jsx-dev-runtime": "jsx-runtime",
            "react/jsx-runtime": "jsx-runtime",
            "react-i18next": "i18n",
            "./button": "button",
            "./textarea": "textarea",
            "lucide-react": "icons",
            "./dialog": "dialog",
          };
          if (modules[source]) return `\0prompt-studio-${modules[source]}`;
          if (source.endsWith("/hooks/useDialogs")) return "\0prompt-studio-dialogs";
          if (source.endsWith("/utils/agentName")) return "\0prompt-studio-agent-name";
          if (source.endsWith("/services/ReasoningService")) return "\0prompt-studio-reasoning";
          if (source.endsWith("/models/ModelRegistry")) return "\0prompt-studio-models";
          if (source.endsWith("/utils/logger")) return "\0prompt-studio-logger";
          if (source.endsWith("/config/prompts")) return "\0prompt-studio-prompts";
          if (source.endsWith("/stores/settingsStore")) return "\0prompt-studio-settings";
          if (source.endsWith("/utils/languageSupport")) return "\0prompt-studio-language";
          if (source.endsWith("/utils/snippets")) return "\0prompt-studio-snippets";
          if (source.endsWith("/helpers/dictationAgentInference")) {
            return "\0prompt-studio-agent-inference";
          }
          return null;
        },
        load(id) {
          if (id === "\0prompt-studio-react") {
            return `
              let call = 0;
              export function useState(initial) {
                call += 1;
                const value = call === 1 ? "test" : typeof initial === "function" ? initial() : initial;
                return [value, () => {}];
              }
            `;
          }
          if (id === "\0prompt-studio-jsx-runtime") {
            return `
              export const Fragment = Symbol.for("prompt-studio-fragment");
              export function jsxDEV(type, props, key) { return { type, props, key }; }
              export const jsx = jsxDEV;
              export const jsxs = jsxDEV;
            `;
          }
          if (id === "\0prompt-studio-i18n") {
            return `export function useTranslation() { return { t: (key) => key }; }`;
          }
          if (id === "\0prompt-studio-button") return "export function Button() {}";
          if (id === "\0prompt-studio-textarea") return "export function Textarea() {}";
          if (id === "\0prompt-studio-icons") {
            return `
              export const Eye = () => null;
              export const Edit3 = () => null;
              export const Play = () => null;
              export const Save = () => null;
              export const RotateCcw = () => null;
              export const Copy = () => null;
              export const TestTube = () => null;
              export const AlertTriangle = () => null;
              export const Check = () => null;
            `;
          }
          if (id === "\0prompt-studio-dialog") return "export function AlertDialog() {}";
          if (id === "\0prompt-studio-dialogs") {
            return `
              export function useDialogs() {
                return {
                  alertDialog: { open: false, title: "", description: "" },
                  showAlertDialog() {},
                  hideAlertDialog() {},
                };
              }
            `;
          }
          if (id === "\0prompt-studio-agent-name") {
            return `export function useAgentName() { return { agentName: "Whisper" }; }`;
          }
          if (id === "\0prompt-studio-reasoning") {
            return `
              export default {
                async processText(...args) {
                  globalThis.__promptStudioReasoningCalls.push(args);
                  return "result";
                },
              };
            `;
          }
          if (id === "\0prompt-studio-models") {
            return `export function getModelProvider() { return "openai"; }`;
          }
          if (id === "\0prompt-studio-logger") {
            return `export default { debug() {}, error() {} };`;
          }
          if (id === "\0prompt-studio-prompts") {
            return `
              export function getDefaultPromptText() { return "default prompt"; }
              export function resolvePrompt() { return "resolved agent prompt"; }
            `;
          }
          if (id === "\0prompt-studio-settings") {
            return `
              const state = {
                uiLanguage: "en",
                useCleanupModel: true,
                cleanupModel: "",
                useDictationAgent: true,
                dictationAgentProvider: "openwhispr",
                dictationAgentModel: "auto",
                useDictationTranslation: true,
                translationMode: "openwhispr",
                translationProvider: "openwhispr",
                translationModel: "auto",
                translationRemoteUrl: "",
                translationCloudBaseUrl: "",
                translationCustomApiKey: "",
                translationDisableThinking: false,
                translationTargetLanguage: "es",
                customPrompts: { cleanup: "", dictationAgent: "", translate: "" },
                preferredLanguage: "en",
                cleanupDisableThinking: false,
                setCustomPrompt() {},
              };
              export function useSettingsStore(selector) { return selector(state); }
              useSettingsStore.getState = () => state;
              export const selectIsCloudCleanupMode = () => true;
              export const selectIsCloudDictationAgentMode = () => true;
              export const selectIsCloudTranslationMode = () => true;
            `;
          }
          if (id === "\0prompt-studio-language") {
            return `export function getLanguageLabel(value) { return value; }`;
          }
          if (id === "\0prompt-studio-snippets") {
            return `export function getDictionaryHintWords() { return []; }`;
          }
          if (id === "\0prompt-studio-agent-inference") {
            return `
              export function resolveDictationAgentInference() {
                return { reachable: true, model: "auto", config: { provider: "openwhispr" } };
              }
            `;
          }
          return null;
        },
      },
    ],
    server: { middlewareMode: true },
  });

  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    delete globalThis.__promptStudioReasoningCalls;
  });

  const { default: PromptStudio } = await vite.ssrLoadModule("/components/ui/PromptStudio.tsx");
  const rendered = PromptStudio({ kind: "dictationAgent" });
  const runButton = findRunButton(rendered);
  assert.ok(runButton, "expected the Prompt Studio test action to render");

  await runButton.props.onClick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].requiresAgent, true);
});
