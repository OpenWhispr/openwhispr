import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { onPolicyRestriction } from "../reasoningPolicy";

export function guardLanguageModel(model: LanguageModelV3, assertAllowed: () => void) {
  const watch = (params: LanguageModelV3CallOptions) => {
    assertAllowed();
    const controller = new AbortController();
    const unsubscribe = onPolicyRestriction(assertAllowed, (error) => controller.abort(error));
    const signal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, controller.signal])
      : controller.signal;
    return {
      signal,
      unsubscribe,
      assert() {
        signal.throwIfAborted();
        assertAllowed();
      },
    };
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ params, model }) {
        const scope = watch(params);
        try {
          const result = await model.doGenerate({ ...params, abortSignal: scope.signal });
          scope.assert();
          return result;
        } finally {
          scope.unsubscribe();
        }
      },
      async wrapStream({ params, model }) {
        const scope = watch(params);
        try {
          const result = await model.doStream({ ...params, abortSignal: scope.signal });
          scope.assert();
          const reader = result.stream.getReader();
          let onAbort: () => void;
          const cleanup = () => {
            scope.unsubscribe();
            scope.signal.removeEventListener("abort", onAbort);
          };
          const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              onAbort = () => {
                cleanup();
                controller.error(scope.signal.reason);
                void reader.cancel(scope.signal.reason).catch(() => {});
              };
              scope.signal.addEventListener("abort", onAbort, { once: true });
            },
            async pull(controller) {
              try {
                scope.assert();
                const chunk = await reader.read();
                scope.assert();
                if (chunk.done) {
                  cleanup();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                cleanup();
                controller.error(error);
                void reader.cancel(error).catch(() => {});
              }
            },
            cancel(reason) {
              cleanup();
              return reader.cancel(reason);
            },
          });
          return { ...result, stream };
        } catch (error) {
          scope.unsubscribe();
          throw error;
        }
      },
    },
  });
}
