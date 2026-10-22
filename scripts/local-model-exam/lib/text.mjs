// Drives the app's local text-model paths. Cleanup goes through the same chain
// as a dictation (services/ai/inferenceProviders/local.ts -> localReasoningBridge ->
// modelManager.runInference -> llama-server). The agent replicates the local
// tool path in useChatStreaming.ts / ReasoningService.processTextStreamingAI,
// with every tool's execute replaced by a recorder, so nothing real is touched.
// Call installElectronStub() before using this module.
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./electron.mjs";

const require = createRequire(import.meta.url);
const src = (relative) => path.join(REPO_ROOT, "src", relative);
const importSrc = (relative) => import(pathToFileURL(src(relative)).href);

let mods = null;
async function load() {
  if (mods) return mods;
  const modelManager = require(src("helpers/modelManagerBridge.js")).default;
  const bridge = require(src("services/localReasoningBridge.js")).default;
  const prompts = await importSrc("config/prompts.ts");
  const { assertValidCleanupOutput } = await importSrc("utils/cleanupOutput.ts");
  const { createToolRegistry } = await importSrc("services/tools/index.ts");
  const { createOpenAI } = await import("@ai-sdk/openai");
  const ai = await import("ai");
  mods = {
    modelManager,
    bridge,
    prompts,
    assertValidCleanupOutput,
    createToolRegistry,
    createOpenAI,
    ai,
  };
  return mods;
}

// The app's gate, useChatStreaming.ts LOCAL_TOOL_MIN_PARAMS_B / estimateModelSizeB.
const LOCAL_TOOL_MIN_PARAMS_B = 4;
export function localModelGetsTools(modelId) {
  const match = modelId.match(/-([\d.]+)[bB]/);
  return (match ? parseFloat(match[1]) : 0) >= LOCAL_TOOL_MIN_PARAMS_B;
}

// What a user who finished onboarding with a calendar connected has.
const AGENT_SETTINGS = {
  isSignedIn: true,
  calendarConnected: true,
  cloudBackupEnabled: false,
  webSearchEnabled: true,
  productHelpEnabled: true,
  vocabulary: {
    getDictionary: () => [],
    updateDictionary: () => {},
    getSnippets: () => [],
    setSnippets: () => {},
  },
  connectors: { readyConnectorIds: ["gmail", "slack"], emailDraftTarget: "gmail" },
};

export async function listAgentTools() {
  const { createToolRegistry } = await load();
  return createToolRegistry(AGENT_SETTINGS)
    .getAll()
    .map((t) => ({
      name: t.name,
      readOnly: t.readOnly,
      connectorId: t.connectorId || null,
      parameters: t.parameters,
    }));
}

// The app's own model download; a no-op when the file is already in the cache.
export async function downloadTextModel(modelId) {
  const { modelManager } = await load();
  return modelManager.downloadModel(modelId);
}

export async function ensureServer(modelId) {
  const { modelManager } = await load();
  modelManager.ensureInitialized();
  const info = modelManager.findModelById(modelId);
  if (!info) throw new Error(`Unknown text model: ${modelId}`);
  const started = performance.now();
  if (modelManager.currentServerModelId !== modelId || !modelManager.serverManager.port) {
    const modelPath = path.join(modelManager.modelsDir, info.model.fileName);
    await modelManager.serverManager.start(modelPath, await modelManager.serverStartOptions(info));
    modelManager.currentServerModelId = modelId;
  }
  return { port: modelManager.serverManager.port, loadMs: performance.now() - started };
}

export async function stopTextModel() {
  if (!mods) return;
  await mods.modelManager.serverManager.stop?.().catch(() => {});
  mods.modelManager.currentServerModelId = null;
}

export async function cleanupSystemPrompt(language = "en") {
  const { prompts } = await load();
  return prompts.getCleanupSystemPrompt(null, [], language, "en", null);
}

// One dictation cleanup, as the app sends it with cleanup on (the default).
export async function cleanup(modelId, transcript, { language = "en" } = {}) {
  const { bridge, prompts, assertValidCleanupOutput } = await load();
  const systemPrompt = await cleanupSystemPrompt(language);
  const userContent = prompts.wrapCleanupTranscript(transcript);
  const started = performance.now();
  try {
    const output = await bridge.processText(userContent, modelId, {
      inferenceScope: "dictationCleanup",
      disableThinking: true,
      temperature: 0,
      requireCompleteOutput: true,
      systemPrompt,
    });
    const ms = performance.now() - started;
    try {
      assertValidCleanupOutput(transcript, output);
    } catch {
      return { ok: false, output, ms, error: "duplicated-output" };
    }
    return { ok: true, output, ms };
  } catch (error) {
    return {
      ok: false,
      output: "",
      ms: performance.now() - started,
      error: error.code || error.message,
    };
  }
}

// Reads llama-server's own timings from each response without disturbing the
// stream the AI SDK consumes: how many prompt tokens it read, how many it
// reused from the previous request, and how fast it wrote.
function timingFetch(onTimings) {
  return async (input, init) => {
    const response = await fetch(input, init);
    response
      .clone()
      .text()
      .then((body) => {
        for (const line of body.split("\n")) {
          const json = line.startsWith("data: ") ? line.slice(6) : line;
          if (!json.includes('"timings"')) continue;
          try {
            onTimings(JSON.parse(json).timings);
          } catch {
            // Not a complete JSON line.
          }
        }
      })
      .catch(() => {});
    return response;
  };
}

// One agent turn on the local tool path, with recorded fake tools.
export async function agentTurn(modelId, task, { onTimings } = {}) {
  const { createToolRegistry, prompts, createOpenAI, ai } = await load();
  const { port, loadMs } = await ensureServer(modelId);
  const gets = localModelGetsTools(modelId);
  const registry = gets ? createToolRegistry(AGENT_SETTINGS) : null;
  const calls = [];
  const t0 = performance.now();
  for (const def of registry?.getAll() || []) {
    def.execute = async (args) => {
      calls.push({ name: def.name, args, atMs: performance.now() - t0 });
      const canned = task.cannedFor
        ? task.cannedFor(def.name, args)
        : task.cannedResults?.[def.name];
      return canned ?? { success: true, data: { ok: true }, displayText: "" };
    };
  }
  const systemPrompt = prompts.appendDictionarySuffix(
    prompts.getAgentSystemPrompt(registry?.getAll(), undefined, {
      unavailable: [],
      toolTrace: registry !== null,
      userName: "Alex",
    }),
    [],
    "en"
  );
  const tools = registry ? registry.toAISDKFormat() : undefined;
  let firstVisibleMs = null;
  let firstToolMs = null;
  let text = "";
  let error = null;
  let inThink = false;
  try {
    const result = ai.streamText({
      model: createOpenAI({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "local",
        ...(onTimings ? { fetch: timingFetch(onTimings) } : {}),
      }).chat(modelId),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.prompt },
      ],
      tools,
      stopWhen: ai.stepCountIs(tools ? 20 : 1),
      temperature: 0.3,
      maxOutputTokens: 4096,
    });
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") {
        const piece = chunk.text ?? chunk.delta ?? "";
        if (piece.includes("<think>")) inThink = true;
        if (!inThink && piece.trim() && firstVisibleMs === null)
          firstVisibleMs = performance.now() - t0;
        if (piece.includes("</think>")) inThink = false;
        text += piece;
      } else if (chunk.type === "tool-call" && firstToolMs === null) {
        firstToolMs = performance.now() - t0;
      } else if (chunk.type === "error") {
        error = String(chunk.error?.message || chunk.error);
      }
    }
  } catch (e) {
    error = e.message;
  }
  const visible = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  return {
    gotTools: gets,
    calls,
    finalText: visible,
    firstWordsMs:
      [firstVisibleMs, firstToolMs].filter((x) => x !== null).sort((a, b) => a - b)[0] ?? null,
    totalMs: performance.now() - t0,
    loadMs,
    error,
  };
}
