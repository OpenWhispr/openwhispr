import {
  buildActionSystemPromptCore,
  MEETING_CONTENT_RULES,
  type BuildActionSystemPromptInput as CommonPromptInput,
} from './generateNotesPromptCore';
import { DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT } from './desktopDefaultNotesPrompt';
export { isDefaultGenerateNotesAction } from './generateNotesPromptCore';
export type { GenerateNotesInputKind } from './generateNotesPromptCore';

export interface BuildActionSystemPromptInput extends CommonPromptInput {
  outputFormat?: 'markdown' | 'json';
  desktopDefaultNotes?: boolean;
}

export const buildActionSystemPrompt = (input: BuildActionSystemPromptInput): string => {
  const usesDesktopDefaultNotes =
    input.desktopDefaultNotes &&
    input.inputKind === 'plain-note' &&
    input.isDefaultGenerateNotesAction;
  const promptOverride = usesDesktopDefaultNotes
    ? DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT
    : input.inputKind === 'meeting-transcript' &&
        input.isDefaultGenerateNotesAction &&
        input.outputFormat === 'json'
      ? `You are a professional meeting notes assistant. Transcript lines contain timestamps, spoken words and optional speaker labels. Produce concise structured meeting notes.\n\n${MEETING_CONTENT_RULES}\n\nInstructions: ${input.actionPrompt}`
      : undefined;
  return buildActionSystemPromptCore(input, promptOverride);
};
