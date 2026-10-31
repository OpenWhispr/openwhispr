export interface NoteChatSuggestion {
  label: string;
  /** Only built-in display labels translate; prompt identity stays unchanged. */
  labelKey?: string;
  prompt: string;
}

const MEETING_SUGGESTIONS: readonly NoteChatSuggestion[] = [
  {
    label: 'List action items',
    labelKey: 'noteChat.actionItems',
    prompt: 'What are the next steps from the meeting above that I need to do?',
  },
  {
    label: 'Write follow-up email',
    labelKey: 'noteChat.followupEmail',
    prompt:
      'Write a follow-up email summarizing the meeting above, including decisions and next steps.',
  },
  {
    label: 'Key decisions',
    labelKey: 'noteChat.decisions',
    prompt: 'What decisions were made in the meeting above?',
  },
  {
    label: 'List Q&A',
    labelKey: 'noteChat.qa',
    prompt: 'List the questions asked in the meeting above and the answers given.',
  },
];

const NOTE_SUGGESTIONS: readonly NoteChatSuggestion[] = [
  {
    label: 'Summarize',
    labelKey: 'noteChat.summarize',
    prompt: 'Summarize this note in a few bullet points.',
  },
  {
    label: 'List action items',
    labelKey: 'noteChat.actionItems',
    prompt: 'What are the next steps from this note that I need to do?',
  },
  {
    label: 'Draft an email',
    labelKey: 'noteChat.draftEmail',
    prompt: 'Draft an email based on this note.',
  },
];

export function getNoteChatSuggestions(isMeeting: boolean): readonly NoteChatSuggestion[] {
  return isMeeting ? MEETING_SUGGESTIONS : NOTE_SUGGESTIONS;
}
