import { DEFAULT_ACTION_PROMPT, DEFAULT_CLEANUP_PROMPT } from '@/config/prompts/registry';
import languageRegistry from '@/config/languageRegistry.json';
import { detectAgentMention } from '@/lib/dictationAgent';
import { TONE_INSTRUCTIONS } from '@/services/agent/composerPrompt';
import type { ReasoningRequest } from '@/types';

export interface ProviderPrompt {
  systemPrompt: string;
  text: string;
}

// Wording mirrors the server's getSystemPrompt (openwhispr-api lib/prompts.ts),
// so a provider receives the same instructions OpenWhispr Cloud would send;
// the tone sentences are the server's, shared with the keyboard composer.
const DICTIONARY_PREFIX =
  'Custom Dictionary (use these exact spellings when they appear in the text): ';

function languageInstruction(language: string | undefined): string | undefined {
  if (!language || language === 'en') return undefined;
  const entry: { code: string; instruction?: string } | undefined = languageRegistry.languages.find(
    (candidate) => candidate.code === language,
  );
  return entry?.instruction ?? languageRegistry._genericTemplate.replace('{{code}}', language);
}

export function buildProviderPrompt(request: ReasoningRequest): ProviderPrompt {
  if (request.systemPrompt) return { systemPrompt: request.systemPrompt, text: request.text };
  const agentName = request.agentName?.trim() ?? '';
  const customPrompt = request.customPrompt?.trim() ? request.customPrompt : undefined;
  const actionMode = !customPrompt && !!agentName && detectAgentMention(request.text, agentName);
  const template = customPrompt ?? (actionMode ? DEFAULT_ACTION_PROMPT : DEFAULT_CLEANUP_PROMPT);
  const parts = [template.replace(/\{\{agentName\}\}/g, (): string => agentName)];
  const language = languageInstruction(request.language);
  if (language) parts.push(language);
  const words = request.customDictionary?.map((word) => word.trim()).filter(Boolean) ?? [];
  if (words.length) parts.push(DICTIONARY_PREFIX + words.join(', '));
  const tone = !actionMode && request.tone ? TONE_INSTRUCTIONS[request.tone] : undefined;
  if (tone) parts.push(tone);
  return {
    systemPrompt: parts.join('\n\n'),
    text: actionMode
      ? request.text
      : `<transcript>\n${request.text}\n</transcript>\n\nOutput only the cleaned transcript.`,
  };
}
