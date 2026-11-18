import {
  buildActionSystemPromptCore,
  type BuildActionSystemPromptInput,
} from './generateNotesPromptCore';
export { isDefaultGenerateNotesAction } from './generateNotesPromptCore';
export type {
  GenerateNotesInputKind,
  BuildActionSystemPromptInput,
} from './generateNotesPromptCore';

export const buildActionSystemPrompt = (input: BuildActionSystemPromptInput): string =>
  buildActionSystemPromptCore(input);
