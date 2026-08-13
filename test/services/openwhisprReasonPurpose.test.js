const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("OpenWhispr reasoning labels only dictation-agent requests for server enforcement", async (t) => {
  const originalWindow = globalThis.window;
  const requests = [];
  globalThis.window = {
    electronAPI: {
      cloudReason: async (_text, options) => {
        requests.push(options);
        return { success: true, text: "result", model: "model", provider: "openwhispr" };
      },
    },
  };

  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-reason-purpose-test-"));
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: "openwhispr-reason-purpose-dependencies",
        enforce: "pre",
        resolveId(source) {
          if (source.endsWith("/lib/auth")) return "\0reason-purpose-auth";
          if (source.endsWith("/stores/settingsStore")) return "\0reason-purpose-settings";
          if (source.endsWith("/utils/logger")) return "\0reason-purpose-logger";
          return null;
        },
        load(id) {
          if (id === "\0reason-purpose-auth") {
            return "export async function withSessionRefresh(callback) { return callback(); }";
          }
          if (id === "\0reason-purpose-settings") {
            return "export function getSettings() { return { customPrompts: { cleanup: '' } }; }";
          }
          if (id === "\0reason-purpose-logger") {
            return "export default { logReasoning() {} };";
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
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  const { openwhisprProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/openwhispr.ts"
  );
  const context = {
    getCustomDictionary: () => [],
    getPreferredLanguage: () => "en",
    getUiLanguage: () => "en",
  };

  await openwhisprProvider.call({
    text: "do this",
    model: "",
    agentName: "Whisper",
    config: { systemPrompt: "Act on the request.", requiresAgent: true },
    ctx: context,
  });
  await openwhisprProvider.call({
    text: "clean this",
    model: "",
    agentName: "Whisper",
    config: {},
    ctx: context,
  });

  assert.equal(requests[0].requestPurpose, "agent");
  assert.equal(requests[1].requestPurpose, undefined);
  assert.equal(requests[1].promptMode, "cleanup");
});
