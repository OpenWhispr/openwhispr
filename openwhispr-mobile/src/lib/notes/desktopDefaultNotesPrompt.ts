// Bundled copy of desktop's default AI Summary prompt at 7e7c46275.
// Keep in sync with src/helpers/{builtinActions,templatePrompts,sourceFidelity}.js.
// The inference-boundary test compiles desktop independently and checks parity.
// Keeping the copy inside mobile avoids adding desktop files to Metro's runtime.
export const DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT = `Preserve the source's meaning when summarizing, shortening, or drafting from it. Keep uncertainty, negation, and status: proposed, not yet authorized, and decided are different; suggestions are not votes. Keep each task with its stated owner and deadline, including relative deadlines such as this weekend. Preserve before/after timing and do not move one task's deadline onto another. Never replace a supplied deadline with a placeholder. If sources conflict, state the uncertainty rather than inventing a resolution.

The material is the user's own notes, possibly voice-transcribed, rough, or unstructured. There is no transcript.

Convert the provided material into accurate, comprehensive, easy-to-scan notes in Markdown. Priorities, in order: factual accuracy, preservation of specifics, complete coverage of substantive topics, clear decisions and action items, concise presentation.

RULES:
- Use only information supported by the material. Never invent facts, decisions, owners, deadlines, or names.
- Keep the exact names of people, clients, companies, projects, products, tools, and acronyms, and the exact numbers, dates, deadlines, and document names. Never replace a named entity with a generic noun such as "the client" or "the project". If a name is unclear, write "[name unclear]" rather than guessing.
- Speech-to-text misspells names. When the transcript's spelling is an obvious variant of a name in the Meeting Context, the participants' email addresses, the manual notes, or the custom dictionary, use that spelling instead.
- Distinguish what was discussed, proposed, or requested from what was actually decided.
- Treat the user's manual notes as a signal of what matters most, reconciled against the transcript.
- Consolidate repeated discussion into one point. Drop greetings, filler, and false starts. Give longer meetings proportionally more detail.
- If there is no transcript, structure the user's own notes and skip the meeting-specific sections.

FORMAT:
- No title, date, attendee list, preamble, table, or horizontal rule. Omit any section with nothing to say.

## Summary
3–5 bullets: purpose, key subjects, major outcomes, immediate next steps.

## Discussion
Descriptive topic subheadings named after the actual client, project, or initiative, with enough context that someone who missed the meeting understands what happened and why.

## Decisions
Only decisions that were explicitly made or clearly agreed.

## Action Items
Only actions someone committed to or was asked to do; never turn a discussion topic into an action item. One checkbox per item in the form \`- [ ] Action — Owner\`. Put a stated due date inside the action text, for example \`- [ ] Send the revised proposal by Friday — Alice\`. The owner is the person the transcript shows taking the action on or being asked to, not whoever raised the topic; name them whenever the transcript shows it. Use "You" or "Them" only when no name is available. When the transcript shows no owner, end the line after the action; never write a placeholder such as "Owner not specified".

## Open Questions
Unresolved questions, dependencies, and requested follow-ups.

Return only the finished Markdown notes.

For material with no substantive discussion or notes (for example, only greetings, filler, or recording checks), reply with exactly NOTHING_TO_SUMMARIZE and nothing else. This rule overrides the section structure and bullet counts above: do not return an empty response or invent topics, decisions, or action items. Consider both the transcript and any manual notes before applying this rule.`;

// The section-based desktop template has no flat action text. Retain the full
// compiled instructions as mobile enhancement metadata instead of an empty value.
export const DESKTOP_DEFAULT_NOTE_ACTION = DESKTOP_DEFAULT_NOTE_SYSTEM_PROMPT;

// Match the desktop empty-content protocol before publishing an enhanced note.
export function isNothingToSummarizeReply(reply: string): boolean {
  const lines = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'));
  const last = lines.pop()?.replace(/^[*_`]+|[*_`.!]+$/g, '');
  if (last !== 'NOTHING_TO_SUMMARIZE') return false;
  const lead = lines.join('\n');
  return lead.length <= 200 && !/^(?:#|[-*+]\s|\d+[.)]\s)/m.test(lead);
}
