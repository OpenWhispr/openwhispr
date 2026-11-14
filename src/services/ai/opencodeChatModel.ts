import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { getOpencodeCatalogModel } from "../../models/ModelRegistry";
import { resolveOpencodeModelRoute } from "../../config/opencodeModelPolicy.js";

// OpenCode Go/Zen run entirely in main: opencode.ai answers no CORS preflight,
// so a renderer fetch is blocked before it is sent. This LanguageModelV3 shim
// keeps streamText and tool execution in the renderer while proxying doStream
// over IPC, the same shape as the enterprise chat model. Main owns the key, the
// base URL and Go's per-conversation session header.

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

export type OpenCodeProviderId = "opencode-go" | "opencode-zen";

export function createOpencodeChatModel(
  provider: OpenCodeProviderId,
  modelId: string
): LanguageModelV3 {
  // One session per model instance (one chat turn): every tool step of the
  // turn then reads as the same conversation to OpenCode Go's router.
  const sessionId = crypto.randomUUID();
  // The model's native protocol and inference base travel in the payload's
  // config; main validates the base URL before attaching the key.
  const route = resolveOpencodeModelRoute(getOpencodeCatalogModel(provider, modelId));
  return {
    specificationVersion: "v3",
    provider,
    modelId,
    supportedUrls: {},

    async doGenerate() {
      throw new Error("OpenCode chat models are streaming-only; use doStream.");
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const api = window.electronAPI;
      if (!api?.opencodeStreamStart || !api.onOpencodeStreamPart) {
        throw new Error("OpenCode streaming is not available in this environment");
      }

      const streamId = crypto.randomUUID();
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const stopListening = () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          const fail = (message: string) => {
            if (settled) return;
            settled = true;
            stopListening();
            controller.error(new Error(message));
          };

          // A turn cancelled before its first step should not open a request.
          if (options.abortSignal?.aborted) {
            settled = true;
            controller.close();
            return;
          }

          unsubscribe = api.onOpencodeStreamPart!((payload) => {
            if (payload.streamId !== streamId) return;
            if (payload.error) {
              fail(payload.error);
            } else if (payload.done) {
              if (settled) return;
              settled = true;
              stopListening();
              controller.close();
            } else if (payload.part) {
              controller.enqueue(payload.part as LanguageModelV3StreamPart);
            }
          });

          options.abortSignal?.addEventListener("abort", () => {
            api.opencodeStreamCancel?.(streamId);
          });

          api.opencodeStreamStart!({
            streamId,
            sessionId,
            provider,
            modelId,
            config: { protocol: route.protocol, baseUrl: route.baseUrl },
            options: pickSerializableOptions(options),
          })
            .then((result) => {
              if (result && !result.success) fail(result.error || "OpenCode stream failed");
            })
            .catch((error: Error) => fail(error.message));
        },
        cancel: () => {
          // The consumer is gone; a late error/done must not touch a closed controller.
          settled = true;
          stopListening();
          api.opencodeStreamCancel?.(streamId);
        },
      });

      return { stream };
    },
  };
}
