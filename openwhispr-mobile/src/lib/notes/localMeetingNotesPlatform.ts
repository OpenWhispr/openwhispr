import { AppleLLM } from '@/lib/appleLLM';
import { LOCAL_OUTPUT_TOKEN_RESERVE } from '@/lib/localReasoning';
import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';
import type { StructuredMeetingNotes } from '@/types';

export interface LocalMeetingNotesPlatform {
  modelName: string;
  buildInstructions(actionPrompt: string): string;
  generateNotes(input: { instructions: string; prompt: string }): Promise<StructuredMeetingNotes>;
  getCheckpoint(options: { checkpoint?: () => void }): (() => void) | undefined;
}

export const localMeetingNotesPlatform: LocalMeetingNotesPlatform = {
  modelName: 'apple-fm',
  buildInstructions: (actionPrompt) =>
    buildActionSystemPrompt({
      actionPrompt,
      inputKind: 'meeting-transcript',
      isDefaultGenerateNotesAction: true,
    }),
  generateNotes: (input) =>
    AppleLLM.generateMeetingNotes({
      instructions: input.instructions,
      prompt: input.prompt,
      temperature: 0.2,
      maxTokens: LOCAL_OUTPUT_TOKEN_RESERVE,
    }),
  getCheckpoint: () => undefined,
};
