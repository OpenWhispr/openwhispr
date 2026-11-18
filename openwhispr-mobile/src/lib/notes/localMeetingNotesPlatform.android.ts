import { z } from 'zod';
import { LOCAL_OUTPUT_TOKEN_RESERVE } from '@/lib/localReasoning';
import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';
import type { LocalMeetingNotesPlatform } from './localMeetingNotesPlatform';

const androidMeetingNotesSchema = z.object({
  summary: z.string(),
  keyDiscussionPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(z.object({ text: z.string(), owner: z.string().nullable() })),
  followUps: z.array(z.string()),
});
const ANDROID_MEETING_FORMAT =
  'Return only a JSON object with summary (string), keyDiscussionPoints (string array), decisions (string array), actionItems (array of {text: string, owner: string or null}), and followUps (string array). Use empty arrays when no items are supported. Do not use Markdown or code fences.';

export const localMeetingNotesPlatform: LocalMeetingNotesPlatform = {
  modelName: 'android-local',
  buildInstructions: (actionPrompt) => {
    const promptInput = {
      actionPrompt,
      inputKind: 'meeting-transcript' as const,
      isDefaultGenerateNotesAction: true,
      outputFormat: 'json',
    };
    return `${buildActionSystemPrompt(promptInput)}\n\n${ANDROID_MEETING_FORMAT}`;
  },
  generateNotes: async (input) => {
    const { LocalTextModel } =
      require('@/android/LocalTextModel') as typeof import('@/android/LocalTextModel');
    const result = await LocalTextModel.processText({
      systemPrompt: input.instructions,
      text: input.prompt,
      temperature: 0.2,
      maxTokens: LOCAL_OUTPUT_TOKEN_RESERVE,
      responseSchema: z.toJSONSchema(androidMeetingNotesSchema),
    });
    return androidMeetingNotesSchema.parse(JSON.parse(result.text));
  },
  getCheckpoint: (options) => options.checkpoint ?? (() => {}),
  isOutputLimitError: (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'LOCAL_OUTPUT_LIMIT',
};
