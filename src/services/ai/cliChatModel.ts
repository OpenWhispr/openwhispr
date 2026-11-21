import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { LlmCliSeat } from "../../types/electron";
import { flattenPromptToText } from "../../helpers/llmCliProviders.js";
import { errorMessageKey } from "../../helpers/llmCli/llmCliSeatView.js";
import { cliModelIdFor } from "../../helpers/llmCli/llmCliRouting.js";

// Subscription CLIs run in the main process (src/helpers/llmCli). This
// LanguageModelV3 shim proxies doStream over IPC the way enterpriseChatModel
// does: main relays each AI SDK part verbatim, then {done} or {error, code}.
// Only the flattened prompt text crosses the boundary; the CLIs run with their
// own tools off, so the stream carries text only.

export type CliStreamError = Error & { code?: string; messageKey?: string | null };

export function createCliChatModel(seat: LlmCliSeat, modelId: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: `cli.${seat}`,
    modelId,
    supportedUrls: {},

    async doGenerate() {
      throw new Error("CLI chat models are streaming-only; use doStream.");
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const api = window.electronAPI;
      if (!api?.llmCliStreamStart || !api.onLlmCliStreamPart) {
        throw new Error("CLI streaming is not available in this environment");
      }

      const streamId = crypto.randomUUID();
      let unsubscribe: (() => void) | undefined;
      const stopListening = () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          let settled = false;
          const fail = (message: string, code?: string) => {
            if (settled) return;
            settled = true;
            stopListening();
            const error: CliStreamError = new Error(message);
            if (code) {
              error.code = code;
              error.messageKey = errorMessageKey(code);
            }
            controller.error(error);
          };

          unsubscribe = api.onLlmCliStreamPart!((payload) => {
            if (payload.streamId !== streamId) return;
            if (payload.error) {
              fail(payload.error, payload.code);
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
            api.llmCliStreamCancel?.(streamId);
          });

          api.llmCliStreamStart!({
            streamId,
            seat,
            modelId: cliModelIdFor(modelId),
            prompt: flattenPromptToText(options.prompt),
          })
            .then((result) => {
              if (result && result.success === false) {
                fail(result.error || "CLI stream failed", result.code);
              }
            })
            .catch((error: Error) => fail(error.message));
        },
        cancel: () => {
          stopListening();
          api.llmCliStreamCancel?.(streamId);
        },
      });

      return { stream };
    },
  };
}
