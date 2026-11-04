import { initLlama, type LlamaContext } from 'llama.rn';
import Constants from 'expo-constants';
import { ANDROID_MODELS, modelPath, modelReady } from './models';
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
export type AndroidTextModelId = 'qwen-small' | 'qwen-balanced' | 'qwen-cleanup';
export function selectedTextModel(
  purpose?: ReasoningRequest['localModelPurpose'],
): AndroidTextModelId {
  if (purpose === 'cleanup') return 'qwen-cleanup';
  return useConfigStore.getState().config?.androidTextModel === 'qwen-small'
    ? 'qwen-small'
    : 'qwen-balanced';
}
export function textModelDownloadMessage(model: AndroidTextModelId): string {
  return `${ANDROID_MODELS[model].title}: ${i18n.t('workflowSettings.localModelNeeded')}`;
}
export async function androidTextReadiness(
  purpose?: ReasoningRequest['localModelPurpose'],
): Promise<LocalReasoningReadiness> {
  const model = selectedTextModel(purpose);
  const ready = await modelReady(model);
  return {
    status: ready ? 'ready' : 'modelNotReady',
    contextSize: 4096,
    tokenCounting: false,
    ...(!ready ? { unavailableMessage: textModelDownloadMessage(model) } : {}),
  };
}
export const LocalTextModel = {
  async processText(
    request: ReasoningRequest & { responseSchema?: object },
    model: AndroidTextModelId = selectedTextModel(request.localModelPurpose),
  ): Promise<ReasoningResponse> {
    return withAndroidInference(() =>
      exclusive(async () => {
        if (request.signal?.aborted) throw new Error(i18n.t('generationCancelled'));
        await AndroidDictation!.releaseParakeet();
        await AndroidDictation!.releaseMoonshine();
        if (!(await modelReady(model))) throw new Error(textModelDownloadMessage(model));
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
            ...(model === 'qwen-cleanup' ? { n_threads: 4, no_extra_bufts: true } : {}),
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
            ...(model === 'qwen-cleanup'
              ? {
                  jinja: true,
                  reasoning_format: 'auto' as const,
                  top_k: 20,
                  top_p: 0.8,
                  min_p: 0,
                  penalty_present: 0,
                  penalty_freq: 0,
                  penalty_repeat: 1,
                  penalty_last_n: 4096,
                  seed: 196,
                  n_threads: 4,
                }
              : {}),
            n_predict: Math.min(request.maxTokens ?? (model === 'qwen-cleanup' ? 900 : 384), 900),
            temperature: request.temperature ?? (model === 'qwen-cleanup' ? 0.7 : 0),
            stop: ['<|im_end|>', '<|endoftext|>'],
          });
          if (request.signal?.aborted) throw new Error(i18n.t('generationCancelled'));
          if (result.context_full || result.truncated) {
            throw Object.assign(new Error('Local model context is full.'), {
              code: 'LOCAL_CONTEXT_LIMIT',
            });
          }
          if (result.stopped_limit) {
            throw Object.assign(new Error(i18n.t('responseTooLong')), {
              code: 'LOCAL_OUTPUT_LIMIT',
            });
          }
          if (diagnostics)
            console.info(
              '[android-reasoning] complete',
              model,
              Date.now() - startedAt,
              JSON.stringify(result.timings),
            );
          const text = (model === 'qwen-small' ? result.text : result.content)?.trim();
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
