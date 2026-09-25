export interface NoteChatSuggestion {
  label: string;
  prompt: string;
}

const MEETING_SUGGESTIONS: readonly NoteChatSuggestion[] = [
  {
    label: 'List action items',
    prompt: 'What are the next steps from the meeting above that I need to do?',
  },
  {
    label: 'Write follow-up email',
    prompt:
      'Write a follow-up email to the attendees summarizing the meeting above, including decisions and next steps.',
  },
  {
    label: 'Key decisions',
    prompt: 'What decisions were made in the meeting above?',
  },
  {
    label: 'List Q&A',
    prompt: 'List the questions asked in the meeting above and the answers given.',
  },
];

const NOTE_SUGGESTIONS: readonly NoteChatSuggestion[] = [
  {
    label: 'Summarize',
    prompt: 'Summarize this note in a few bullet points.',
  },
  {
    label: 'List action items',
    prompt: 'What are the next steps from this note that I need to do?',
  },
  {
    label: 'Draft an email',
    prompt: 'Draft an email based on this note.',
  },
];

export function getNoteChatSuggestions(isMeeting: boolean): readonly NoteChatSuggestion[] {
  return isMeeting ? MEETING_SUGGESTIONS : NOTE_SUGGESTIONS;
}
