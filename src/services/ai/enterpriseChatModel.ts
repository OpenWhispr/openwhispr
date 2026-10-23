import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { EnterpriseProvider } from "../../models/ModelRegistry";
import { getEnterpriseCallSettings } from "./enterpriseSettings";
import { errorFromIpcResult } from "../../helpers/ipcErrorFields.js";
import type { InferenceScope } from "../../config/inferenceScopes";

// Enterprise SDKs (Bedrock/Azure/Vertex) must run in the main process — SigV4
// signing and CORS rule out renderer fetches. This LanguageModelV3 shim keeps
// streamText and tool execution in the renderer while proxying doStream over
// IPC: main relays stream parts and maps provider errors to safe IPC fields.

// Structured-clone whitelist — abortSignal and other non-serializable call
// options must not cross the IPC boundary.
const SERIALIZABLE_OPTION_KEYS = [
  "prompt",
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "responseFormat",
  "seed",
  "tools",
  "toolChoice",
  "providerOptions",
] as const;

function pickSerializableOptions(options: LanguageModelV3CallOptions) {
  const picked: Record<string, unknown> = {};
  for (const key of SERIALIZABLE_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export function createEnterpriseChatModel(
  provider: EnterpriseProvider,
  modelId: string,
  inferenceScope: InferenceScope = "chatIntelligence"
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: `enterprise.${provider}`,
    modelId,
    supportedUrls: {},

    async doGenerate() {
      throw new Error("Enterprise chat models are streaming-only; use doStream.");
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const api = window.electronAPI;
      if (!api?.enterpriseStreamStart || !api.onEnterpriseStreamPart) {
        throw new Error("Enterprise streaming is not available in this environment");
      }

      const streamId = crypto.randomUUID();
      const config = getEnterpriseCallSettings(provider, inferenceScope);
      options.abortSignal?.throwIfAborted();
      let unsubscribe: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      const stopListening = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (onAbort) options.abortSignal?.removeEventListener("abort", onAbort);
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            stopListening();
            controller.error(error);
          };

          unsubscribe = api.onEnterpriseStreamPart!((payload) => {
            if (settled || payload.streamId !== streamId) return;
            if (payload.error) {
              fail(errorFromIpcResult(payload));
            } else if (payload.done) {
              if (settled) return;
              settled = true;
              stopListening();
              controller.close();
            } else if (payload.part) {
              controller.enqueue(payload.part as LanguageModelV3StreamPart);
            }
          });

          onAbort = () => {
            fail(options.abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
            void api.enterpriseStreamCancel?.(streamId);
          };
          options.abortSignal?.addEventListener("abort", onAbort, { once: true });

          api.enterpriseStreamStart!({
            streamId,
            provider,
            modelId,
            config,
            options: pickSerializableOptions(options),
          })
            .then((result) => {
              if (result && !result.success) fail(errorFromIpcResult(result));
            })
            .catch((error: Error) => fail(error));
        },
        cancel: () => {
          stopListening();
          api.enterpriseStreamCancel?.(streamId);
        },
      });

      return { stream };
    },
  };
}
