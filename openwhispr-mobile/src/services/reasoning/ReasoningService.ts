import type { ReasoningRequest, ReasoningResponse } from '../../types';
import { api } from '../../lib/apiClient';
import { buildChatOverNotePayload, type ChatOverNoteRequest } from '../../lib/notes/chatOverNote';
import {
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

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

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
      // Let the API resolve a localized cleanup prompt from these fields.
      if (options.language) body.language = options.language;
      if (options.locale) body.locale = options.locale;
      if (options.customDictionary && options.customDictionary.length > 0) {
        body.customDictionary = options.customDictionary;
      }
      if (options.tone && options.tone !== 'default') {
        body.tone = options.tone;
      }
      if (options.customPrompt) {
        body.customPrompt = options.customPrompt;
        body.promptMode = 'cleanup';
      }
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

    const content = stripThinkingTags(data.text || text);

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
    // Only callers that pass a routing hint opt into local/privacy routing.
    // Dictation cleanup and the dictation agent carry no hint and must keep
    // using the cloud path they were built for, regardless of mode or auth.
    const allowCloudFallback = routing?.allowCloudFallback === true;

    if (routing && isLocalReasoningRequired(routing)) {
      if (!systemPrompt && !allowCloudFallback) {
        throw new LocalReasoningError(
          'LOCAL_REASONING_UNAVAILABLE',
          'This content cannot be sent to cloud AI without explicit confirmation.',
        );
      }

      if (systemPrompt) {
        const readiness = await getLocalReasoningReadiness();
        if (readiness.status === 'ready') {
          const instructions = buildLocalReasoningInstructions(request);
          const fits = await fitsLocalReasoningBudget({
            instructions,
            prompt: text,
            readiness,
          });

          if (!fits) {
            if (!allowCloudFallback) {
              throw new LocalReasoningError(
                'LOCAL_CONTEXT_LIMIT',
                'This request is too large for local Apple Intelligence.',
              );
            }
          } else {
            try {
              return await LocalReasoningService.processText(request);
            } catch (error) {
              if (!allowCloudFallback) throw error;
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
    const payload = buildChatOverNotePayload(request);

    return this.callApi(payload.text, {
      systemPrompt: payload.systemPrompt,
      signal: request.signal,
    });
  }
}
