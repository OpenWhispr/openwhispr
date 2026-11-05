import { getNoteChatSuggestions as getDefaultSuggestions } from './noteChatSuggestionsCore';
import type { NoteChatSuggestion as DefaultSuggestion } from './noteChatSuggestionsCore';

export interface NoteChatSuggestion extends DefaultSuggestion {
  /** Display labels translate; prompt identity stays unchanged. */
  labelKey?: string;
}
const withLabels = (isMeeting: boolean, keys: string[]): readonly NoteChatSuggestion[] =>
  getDefaultSuggestions(isMeeting).map((suggestion, index) => ({
    label: suggestion.label,
    labelKey: keys[index],
    prompt: suggestion.prompt,
  }));
const meetings = withLabels(true, [
  'noteChat.actionItems',
  'noteChat.followupEmail',
  'noteChat.decisions',
  'noteChat.qa',
]);
const notes = withLabels(false, [
  'noteChat.summarize',
  'noteChat.actionItems',
  'noteChat.draftEmail',
]);

export function getNoteChatSuggestions(isMeeting: boolean): readonly NoteChatSuggestion[] {
  return isMeeting ? meetings : notes;
}
