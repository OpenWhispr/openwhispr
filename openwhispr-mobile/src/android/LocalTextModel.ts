import { initLlama, type LlamaContext } from 'llama.rn';
import Constants from 'expo-constants';
import { modelPath, modelReady } from './models';
import type { ReasoningRequest, ReasoningResponse, LocalReasoningReadiness } from '@/types';
import { useConfigStore } from '@/store/useConfigStore';
import { AndroidDictation } from '../../modules/android-dictation/src';
import { withAndroidInference } from './inferenceQueue';
import i18n from './strings';
import { buildLocalReasoningInstructions } from './localPrompt';

let context: LlamaContext | null = null;
let loaded: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
const diagnostics = __DEV__ || Constants.expoConfig?.extra?.openWhispr?.isDevelopment === true;
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}
export type AndroidTextModelId = 'qwen-small' | 'qwen-balanced';
export function selectedTextModel(): AndroidTextModelId {
  return useConfigStore.getState().config?.androidTextModel === 'qwen-small'
    ? 'qwen-small'
    : 'qwen-balanced';
}
export async function androidTextReadiness(): Promise<LocalReasoningReadiness> {
  return {
    status: (await modelReady(selectedTextModel())) ? 'ready' : 'modelNotReady',
    contextSize: 4096,
    tokenCounting: false,
  };
}
export const LocalTextModel = {
  async processText(
    request: ReasoningRequest & { responseSchema?: object },
    model: AndroidTextModelId = selectedTextModel(),
  ): Promise<ReasoningResponse> {
    return withAndroidInference(() =>
      exclusive(async () => {
        if (request.signal?.aborted) throw new Error(i18n.t('generationCancelled'));
        await AndroidDictation!.releaseParakeet();
        await AndroidDictation!.releaseMoonshine();
        if (!(await modelReady(model))) throw new Error(i18n.t('textDownloadNeeded'));
        if (!context || loaded !== model) {
          const loadStartedAt = Date.now();
          if (diagnostics) console.info('[android-reasoning] loading', model);
          if (context) await context.release();
          context = null;
          loaded = null;
          context = await initLlama({
            model: modelPath(model),
            n_ctx: 4096,
            cpu_strict: false,
            n_gpu_layers: 0,
            use_mlock: false,
          });
          loaded = model;
          if (diagnostics)
            console.info('[android-reasoning] loaded', model, Date.now() - loadStartedAt);
        }
        const engine = context;
        const stop = () => {
          // llama.rn's JSI implementation can return void despite its Promise type.
          void Promise.resolve()
            .then(() => engine.stopCompletion())
            .catch(() => undefined);
        };
        request.signal?.addEventListener('abort', stop, { once: true });
        try {
          // Cancellation can arrive while native model initialization is pending.
          if (request.signal?.aborted) throw new Error(i18n.t('generationCancelled'));
          const startedAt = Date.now();
          const result = await engine.completion({
            messages: [
              {
                role: 'system',
                content:
                  buildLocalReasoningInstructions(request) ||
                  'Follow the instruction. Return only the requested text.',
              },
              { role: 'user', content: request.text },
            ],
            ...(request.responseSchema
              ? {
                  response_format: {
                    type: 'json_schema' as const,
                    json_schema: { strict: true, schema: request.responseSchema },
                  },
                }
              : {}),
            // Qwen3 defaults to thinking. Keep editing on its non-thinking chat template.
            ...(model === 'qwen-balanced'
              ? {
                  jinja: true,
                  enable_thinking: false,
                  reasoning_format: 'auto' as const,
                  top_k: 20,
                  top_p: 0.8,
                  min_p: 0,
                  penalty_present: 1.5,
                }
              : {}),
            n_predict: Math.min(request.maxTokens ?? 384, 900),
            temperature: request.temperature ?? 0,
            stop: ['<|im_end|>', '<|endoftext|>'],
          });
          if (request.signal?.aborted) throw new Error(i18n.t('generationCancelled'));
          if (result.context_full || result.truncated) {
            throw Object.assign(new Error('Local model context is full.'), {
              code: 'LOCAL_CONTEXT_LIMIT',
            });
          }
          if (result.stopped_limit) throw new Error(i18n.t('responseTooLong'));
          if (diagnostics)
            console.info(
              '[android-reasoning] complete',
              model,
              Date.now() - startedAt,
              JSON.stringify(result.timings),
            );
          const text = (model === 'qwen-balanced' ? result.content : result.text)?.trim();
          if (!text) throw new Error(i18n.t('emptyResponse'));
          return { text, model };
        } finally {
          request.signal?.removeEventListener('abort', stop);
        }
      }),
    ).catch((error: unknown) => {
      // Network retries cannot fix native loading or local generation failures.
      if (error instanceof Error) {
        Object.assign(error, { retryable: false });
        if (error.message === 'Context is full')
          Object.assign(error, { code: 'LOCAL_CONTEXT_LIMIT' });
      }
      throw error;
    });
  },
  async release(): Promise<void> {
    return exclusive(async () => {
      if (context) await context.release();
      context = null;
      loaded = null;
    });
  },
};
