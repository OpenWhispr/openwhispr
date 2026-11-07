import type { InferenceProvider } from "./types";
import { getOpencodeCatalogModel } from "../../../models/ModelRegistry";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import logger from "../../../utils/logger";
import { errorFromIpcResult } from "../../../helpers/ipcErrorFields";

// OpenCode Go and Zen are separate subscriptions on one host, so each has its
// own key and its own provider id. Both requests run in the main process:
// opencode.ai answers no CORS preflight, which blocks a renderer fetch before
// it is sent. Go's session id is minted per chat turn (or per one-shot call)
// and attached in main.
function createOpencodeProvider(
  id: "opencode-go" | "opencode-zen",
  displayName: string
): InferenceProvider {
  return {
    id,
    async call({ text, model, agentName, config, ctx }) {
      if (typeof window === "undefined" || !window.electronAPI) {
        throw new Error(`${displayName} reasoning is not available in this environment`);
      }

      logger.logReasoning("OPENCODE_START", { provider: id, model, agentName });
      const startTime = Date.now();

      const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle);
      const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
      // The live list states whether the model takes a temperature. A model that
      // isn't in the list gets none.
      const supportsTemperature = getOpencodeCatalogModel(id, model)?.supportsTemperature ?? false;

      const result = await window.electronAPI.processOpencodeReasoning(
        id,
        userContent,
        model,
        agentName,
        {
          ...config,
          systemPrompt,
          supportsTemperature,
          // Note formatting gets the long deadline, like the enterprise path.
          timeoutMs: getLlmRequestTimeoutSeconds({ scope: config.inferenceScope }) * 1000,
        }
      );

      if (!result.success) {
        logger.logReasoning("OPENCODE_ERROR", {
          provider: id,
          model,
          processingTimeMs: Date.now() - startTime,
          error: result.error,
        });
        throw errorFromIpcResult(result);
      }

      logger.logReasoning("OPENCODE_SUCCESS", {
        provider: id,
        model,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.text?.length ?? 0,
      });
      return result.text ?? "";
    },
  };
}

export const opencodeGoProvider = createOpencodeProvider("opencode-go", "OpenCode Go");
export const opencodeZenProvider = createOpencodeProvider("opencode-zen", "OpenCode Zen");
