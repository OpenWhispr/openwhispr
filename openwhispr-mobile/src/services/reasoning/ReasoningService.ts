import type { ReasoningRequest, ReasoningResponse, ReasoningRoutingOptions } from '../../types';
import { buildProviderPrompt, stripThinkingTags } from './buildProviderPrompt';
import { api } from '../../lib/apiClient';
import { buildChatOverNotePayload, type ChatOverNoteRequest } from '../../lib/notes/chatOverNote';
import {
  fitsLocalCleanupOutput,
  fitsLocalReasoningBudget,
  getLocalReasoningReadiness,
  getLocalReasoningUnavailableMessage,
  isLocalReasoningRequired,
  LocalReasoningError,
} from '@/lib/localReasoning';
import {
  buildLocalReasoningInstructions,
  LocalReasoningService,
} from '@/services/reasoning/LocalReasoningService';

interface ApiErrorLike {
  status?: number;
  code?: string;
}

// Duck-typed (not `instanceof ApiError`) so this module doesn't need to pull
// in the real apiClient — existing tests mock `{ api: { post } }` in
// isolation and would otherwise see an undefined ApiError import.
function isPolicyModeBlocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ApiErrorLike;
  return e.status === 403 && e.code === 'POLICY_MODE_BLOCKED';
}

interface ReasonApiResponse {
  text: string;
  model: string;
  provider: string;
  processingMs: number;
}

interface CallApiOptions {
  systemPrompt?: string;
  customPrompt?: string;
  language?: string;
  locale?: string;
  customDictionary?: string[];
  tone?: string;
  agentName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Cleanup keeps the dictated text when the server returns none. A chat answer must not, or the
   * whole prompt, notes included, would show as the answer.
   */
  keepTextOnEmptyReply?: boolean;
}

export class ReasoningService {
  private static async callApi(
    text: string,
    options: CallApiOptions = {},
  ): Promise<ReasoningResponse> {
    const body: Record<string, unknown> = {
      text,
      clientType: 'mobile',
    };

    if (options.systemPrompt) {
      // Caller (e.g. action processing) provided its own prompt — preserve it
      // and skip server-side resolution.
      body.systemPrompt = options.systemPrompt;
    } else {
      // Let the API resolve a localized cleanup prompt from these fields. promptMode "cleanup" keeps
      // the API from treating a dictation that addresses the assistant by name as a command: the
      // voice assistant is the keyboard's compose button.
      body.promptMode = 'cleanup';
      if (options.language) body.language = options.language;
      if (options.locale) body.locale = options.locale;
      if (options.customDictionary && options.customDictionary.length > 0) {
        body.customDictionary = options.customDictionary;
      }
      if (options.tone && options.tone !== 'default') {
        body.tone = options.tone;
      }
      if (options.customPrompt) body.customPrompt = options.customPrompt;
    }

    if (options.agentName) {
      body.agentName = options.agentName;
    }

    let data: ReasonApiResponse;
    try {
      data = await api.post<ReasonApiResponse>('/api/reason', body, {
        signal: options.signal,
        headers: options.timeoutMs
          ? {
              'X-OpenWhispr-Client-Timeout-Ms': String(options.timeoutMs),
              'X-OpenWhispr-Cleanup-Timeout-Ms': String(options.timeoutMs),
            }
          : undefined,
      });
    } catch (error) {
      if (isPolicyModeBlocked(error)) {
        throw new Error("Your organization's policy doesn't allow OpenWhispr cloud AI.");
      }
      throw error;
    }

    const keepText = options.keepTextOnEmptyReply ?? true;
    const content = stripThinkingTags(data.text || (keepText ? text : ''));

    if (__DEV__) {
      console.log(
        `[reasoning] provider=${data.provider || 'cloud'} model=${data.model || 'unknown'} serverMs=${
          data.processingMs ?? 'unknown'
        }`,
      );
    }

    return {
      text: content,
      model: data.model || 'unknown',
    };
  }

  static async processText(request: ReasoningRequest): Promise<ReasoningResponse> {
    const {
      text,
      systemPrompt,
      customPrompt,
      language,
      locale,
      customDictionary,
      signal,
      timeoutMs,
      tone,
      agentName,
      routing,
    } = request;
    const { getInferenceSelection, resolveMobileProviderRoute } =
      require('@/lib/inferenceRouting') as typeof import('@/lib/inferenceRouting');
    const scope = request.inferenceScope ?? 'cleanup';
    const configuredSelection = request.inferenceRoute ?? getInferenceSelection(scope);
    const selection = configuredSelection ? { ...configuredSelection } : undefined;
    const usesProviders = selection?.mode === 'providers';
    const localSelected = selection?.mode === 'local';
    const allowCloudFallback = routing?.allowCloudFallback === true;
    const chosenProvider = usesProviders && routing?.sendToChosenProvider === true;
    let privateContent = !chosenProvider && routing?.isPrivateNote === true;
    // Local Mode keeps cleanup and note chat on this iPhone unless the user chose otherwise; note
    // formatting follows its own selection there.
    if (scope !== 'notes' && ((usesProviders && !chosenProvider) || localSelected)) {
      const { useProcessingModeStore } =
        require('@/store/useProcessingModeStore') as typeof import('@/store/useProcessingModeStore');
      privateContent ||= useProcessingModeStore.getState().activeMode === 'private';
    }
    const localRequired =
      localSelected ||
      (usesProviders ? privateContent : !!routing && isLocalReasoningRequired(routing));
    const localRequest =
      (usesProviders || localSelected) && !systemPrompt
        ? { ...request, ...buildProviderPrompt(request) }
        : request;

    if (localRequired) {
      if (!localRequest.systemPrompt && !allowCloudFallback) {
        throw new LocalReasoningError(
          'LOCAL_REASONING_UNAVAILABLE',
          'This content cannot be sent to cloud AI without explicit confirmation.',
        );
      }

      if (localRequest.systemPrompt) {
        const readiness = await getLocalReasoningReadiness();
        if (readiness.status === 'ready') {
          const instructions = buildLocalReasoningInstructions(localRequest);
          const fits =
            (await fitsLocalReasoningBudget({
              instructions,
              prompt: localRequest.text,
              readiness,
            })) &&
            // The input fitting the context isn't enough for cleanup: its reply is as long as the
            // transcript, and Apple Intelligence cuts it off at LOCAL_OUTPUT_TOKEN_RESERVE without an
            // error.
            (scope !== 'cleanup' || (await fitsLocalCleanupOutput(text)));

          if (!fits) {
            if (!allowCloudFallback) {
              throw new LocalReasoningError(
                'LOCAL_CONTEXT_LIMIT',
                'This request is too large for local Apple Intelligence.',
              );
            }
          } else {
            try {
              return await LocalReasoningService.processText(localRequest);
            } catch (error) {
              // A cancelled or timed-out request is over; it must not start again in the cloud.
              if (!allowCloudFallback || signal?.aborted) throw error;
            }
          }
        } else if (!allowCloudFallback) {
          throw new LocalReasoningError(
            'LOCAL_REASONING_UNAVAILABLE',
            getLocalReasoningUnavailableMessage(readiness),
            { readiness },
          );
        }
      }
    }

    if (localSelected) {
      throw new LocalReasoningError(
        'LOCAL_REASONING_UNAVAILABLE',
        'On-device AI is unavailable for this request. Choose a provider or OpenWhispr Cloud in AI Models.',
      );
    }

    if (usesProviders) {
      const route = await resolveMobileProviderRoute(
        scope,
        selection,
        privateContent,
        allowCloudFallback || chosenProvider,
      );
      const { processProviderText } =
        require('@/services/providers/ProviderExecution') as typeof import('@/services/providers/ProviderExecution');
      const prompt = { systemPrompt: localRequest.systemPrompt as string, text: localRequest.text };
      const result = await processProviderText({
        route,
        ...prompt,
        temperature: request.temperature ?? (request.systemPrompt ? undefined : 0),
        maxTokens: request.maxTokens,
        signal,
      });
      return { ...result, text: stripThinkingTags(result.text) };
    }

    return this.callApi(text, {
      systemPrompt,
      customPrompt,
      language,
      locale,
      customDictionary,
      signal,
      timeoutMs,
      tone,
      agentName,
    });
  }

  static async chatOverNote(request: ChatOverNoteRequest): Promise<ReasoningResponse> {
    return this.chat({
      ...buildChatOverNotePayload(request),
      signal: request.signal,
      routing: request.routing,
      inferenceRoute: request.inferenceRoute,
    });
  }

  /** Sends an already-built chat payload through the Note Chat route. */
  static async chat(request: {
    systemPrompt: string;
    text: string;
    signal?: AbortSignal;
    routing?: ReasoningRoutingOptions;
    inferenceRoute?: ReasoningRequest['inferenceRoute'];
  }): Promise<ReasoningResponse> {
    const { getInferenceSelection } =
      require('@/lib/inferenceRouting') as typeof import('@/lib/inferenceRouting');
    const selection = request.inferenceRoute ?? getInferenceSelection('noteChat');
    if (selection?.mode === 'providers' || selection?.mode === 'local') {
      return this.processText({
        text: request.text,
        systemPrompt: request.systemPrompt,
        signal: request.signal,
        inferenceScope: 'noteChat',
        inferenceRoute: request.inferenceRoute,
        routing: request.routing,
      });
    }
    // Cloud note chat keeps its pre-BYOK behavior: the consent dialog in the
    // editor is the privacy gate, and the answer always comes from the hosted model.
    return this.callApi(request.text, {
      systemPrompt: request.systemPrompt,
      signal: request.signal,
      keepTextOnEmptyReply: false,
    });
  }
}
