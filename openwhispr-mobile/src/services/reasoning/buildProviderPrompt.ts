import sharedPrompts from '@shared/ai/prompts.json';
import { DEFAULT_CLEANUP_PROMPT } from '@/config/prompts/registry';
import { detectAgentMention } from '@/lib/dictationAgent';
import type { ReasoningRequest } from '@/types';
import { buildLocalReasoningInstructions } from './LocalReasoningService';

export interface ProviderPrompt {
  systemPrompt: string;
  text: string;
}

export function buildProviderPrompt(request: ReasoningRequest): ProviderPrompt {
  if (request.systemPrompt) return { systemPrompt: request.systemPrompt, text: request.text };
  const agentName = request.agentName?.trim() ?? '';
  const customPrompt = request.customPrompt?.trim() ? request.customPrompt : undefined;
  const actionMode = !customPrompt && !!agentName && detectAgentMention(request.text, agentName);
  const template =
    customPrompt ?? (actionMode ? sharedPrompts.actionPrompt : DEFAULT_CLEANUP_PROMPT);
  const systemPrompt = buildLocalReasoningInstructions({
    ...request,
    systemPrompt: template.replace(/\{\{agentName\}\}/g, (): string => agentName),
    tone: actionMode ? undefined : request.tone,
  });
  return {
    systemPrompt,
    text: actionMode
      ? request.text
      : `<transcript>\n${request.text}\n</transcript>\n\nOutput only the cleaned transcript.`,
  };
}
