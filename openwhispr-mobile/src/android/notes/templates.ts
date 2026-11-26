import type { Action } from '@/android/shared/data';

/**
 * Figma E4, "Write the summary as": the built-in templates, then any of the user's own
 * actions. AI Summary is the app's default Generate Notes action, so a summary written by it
 * on desktop or iOS reads as AI Summary here. Make shorter and Make longer (E1) rewrite the
 * summary that is there, nothing else.
 */
export type SummaryTemplate = {
  key: string;
  name: string;
  description: string;
  /** The default action itself for AI Summary; a built-in prompt for the rest. */
  prompt: string | null;
};

const SECTIONS = (sections: string) =>
  `Write the summary under exactly these markdown headings, in this order, omitting a heading only when nothing in the material belongs under it: ${sections}. Under any heading for next steps or action items use checkboxes (- [ ]) and name an owner only when the material says who.`;

export const BUILT_IN_TEMPLATES: SummaryTemplate[] = [
  {
    key: 'ai-summary',
    name: 'AI Summary',
    description: 'Decisions, action items, discussion',
    prompt: null,
  },
  {
    key: 'brief',
    name: 'Brief',
    description: 'Five bullets, nothing else',
    prompt:
      'Summarise the material in at most five short bullet points covering what matters most. No headings, no preamble, nothing after the bullets.',
  },
  {
    key: 'sales-call',
    name: 'Sales call',
    description: 'Customer, pain, next steps',
    prompt: SECTIONS('## Customer, ## Pain, ## Next steps'),
  },
  {
    key: 'one-on-one',
    name: '1:1',
    description: 'Updates, blockers, follow-ups',
    prompt: SECTIONS('## Updates, ## Blockers, ## Follow-ups'),
  },
  {
    key: 'interview',
    name: 'Interview',
    description: 'Questions, answers, verdict',
    prompt: SECTIONS('## Questions, ## Answers, ## Verdict'),
  },
];

export const SHORTER_PROMPT =
  'The input is an existing summary in markdown. Rewrite it noticeably shorter: keep its headings and every decision, action item and owner, and cut everything else to the fewest words that keep the meaning. Output only the rewritten summary.';

export const LONGER_PROMPT =
  'The input is an existing summary in markdown. Rewrite it in more detail: keep its headings, decisions, action items and owners, and expand each point with the context and reasoning it already implies, without adding facts that are not there. Output only the rewritten summary.';

/** A synthetic action the runner accepts; negative ids never collide with stored actions. */
export function templateAction(template: SummaryTemplate, fallback: Action | null): Action | null {
  if (template.prompt == null) return fallback;
  return {
    id: -1 - BUILT_IN_TEMPLATES.findIndex((value) => value.key === template.key),
    name: template.name,
    description: template.description,
    prompt: template.prompt,
    isDefault: 0,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
  };
}

export function rewriteAction(kind: 'shorter' | 'longer'): Action {
  return {
    id: kind === 'shorter' ? -100 : -101,
    name: kind === 'shorter' ? 'Make shorter' : 'Make longer',
    description: '',
    prompt: kind === 'shorter' ? SHORTER_PROMPT : LONGER_PROMPT,
    isDefault: 0,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
  };
}

/** The template a note's summary was written with, read from the prompt stored beside it. */
export function templateOfNote(
  enhancementPrompt: string | null | undefined,
  actions: Action[],
): string {
  if (enhancementPrompt) {
    const builtIn = BUILT_IN_TEMPLATES.find(
      (template) => template.prompt != null && template.prompt === enhancementPrompt,
    );
    if (builtIn) return builtIn.key;
    const own = actions.find((action) => !action.isDefault && action.prompt === enhancementPrompt);
    if (own) return `action:${own.id}`;
  }
  return 'ai-summary';
}

export function templateName(key: string, actions: Action[]): string {
  if (key.startsWith('action:')) {
    const id = Number(key.slice('action:'.length));
    return actions.find((action) => action.id === id)?.name ?? 'AI Summary';
  }
  return BUILT_IN_TEMPLATES.find((template) => template.key === key)?.name ?? 'AI Summary';
}
