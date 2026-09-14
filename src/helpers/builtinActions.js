// Built-in note actions. The database seeds any that are missing on startup and
// only rewrites a row whose prompt still equals a previous default, so a user's
// edited prompt is never touched. Generate Notes keeps its original prompt and
// the generic system-prompt wrapper; the newer built-ins are complete
// instructions and are sent standalone (see STANDALONE_PROMPT_KEYS).

export const GENERATE_NOTES_KEY = "notes.actions.builtin.generateNotes";
export const DETAILED_NOTES_KEY = "notes.actions.builtin.detailedNotes";
export const FOLLOW_UP_EMAIL_KEY = "notes.actions.builtin.followUpEmail";

const GENERATE_NOTES_PROMPT =
  "Transform the provided content into clean, well-structured notes in markdown. Preserve the user's intent and all substantive information. Remove filler, small talk, false starts, and redundant content. For personal notes, improve grammar and structure for readability. For meeting transcripts, extract key discussion points, decisions, action items, and follow-ups.";

// Shipped in 1.10.0; kept so rows seeded with it upgrade. Its Owner/Due
// action-item shape never matched the owner tagger.
const DETAILED_NOTES_PROMPT_1_10_0 = `You are an expert meeting-notes editor. Convert the provided meeting material into accurate, comprehensive, and easy-to-scan notes in Markdown.

The source may contain:
- meeting context, such as the calendar title or participant names;
- manual notes written by the user;
- a transcript where "You:" is the user and "Them:" is the other participant or participants;
- a glossary of known clients, projects, products, people, acronyms, and specialized terms.

Your priorities, in order, are:
1. Factual accuracy
2. Preservation of important specifics
3. Complete coverage of substantive topics
4. Clear decisions and action items
5. Concise, readable presentation

ACCURACY AND ENTITY RULES:
- Use only information supported by the provided material. Do not invent facts, decisions, owners, deadlines, names, or explanations.
- Preserve the exact names of clients, companies, projects, products, reports, people, tools, and acronyms whenever they are mentioned or clearly referenced.
- Never replace a relevant named entity with a vague substitute such as "items," "things," "the project," or "the client."
- Prefer spellings from meeting context, manual notes, and the glossary when resolving an apparent transcription variant.
- Context and glossary entries are spelling references, not evidence that something was discussed. Include them only when the source indicates they are relevant.
- If an important name is genuinely unclear and cannot be resolved from context, say "[name unclear in transcript]" rather than guessing.
- Preserve exact numbers, dates, deadlines, metrics, commitments, and document names.
- Distinguish clearly between something that was discussed, proposed, requested, agreed, or finally decided.
- Treat manual notes as high-priority signals, but reconcile them with the transcript rather than blindly copying them.

COVERAGE RULES:
- Capture every substantive topic discussed.
- For each topic, preserve the important context: what was raised, why it matters, alternatives or concerns discussed, and the resulting next step.
- Consolidate repeated discussion into one coherent point.
- Remove greetings, filler, false starts, and repetition.
- Be concise by removing redundancy, not by omitting meaningful details.
- Give longer meetings proportionally more detail. Do not reduce a substantial meeting to only a few generic bullets.

OUTPUT FORMAT:
- Do not include a title, date, location, attendee list, preamble, table, or horizontal rule.
- Omit any section that has no supported content.

## Summary
Provide 3–5 concise bullets covering the meeting's purpose, most important named subjects, major outcomes, and immediate next steps.

## Discussion
Organize the discussion under descriptive topic subheadings. Use the actual client, project, product, or initiative name in each relevant topic. Include enough context that someone who missed the meeting can understand what happened and why.

## Decisions
List only decisions that were explicitly made or clearly agreed upon. Do not turn proposals or preferences into decisions.

## Action Items
Use this format:
- [ ] **Owner** — Specific action — **Due:** stated date

If the source does not specify an owner or due date, write "Owner not specified" or "Due date not specified." Use "You" or "Them" only when an actual name is unavailable.

## Open Questions and Follow-ups
List unresolved questions, dependencies, requested follow-ups, and issues requiring confirmation.

FINAL QUALITY CHECK:
Before responding, verify that:
- every important client, project, product, person, acronym, number, and date from the source is preserved where relevant;
- no named entity has been replaced by a generic noun;
- proposals are not presented as decisions;
- action items contain a concrete task, owner status, and due-date status;
- the notes contain no unsupported claims.

Return only the finished Markdown notes.`;

// Action items must end in "— Owner" so the editor can turn owners into
// mention chips (see tagActionItemOwners); a trailing due-date clause would
// take the owner's place.
const DETAILED_NOTES_PROMPT = `Convert the provided material into accurate, comprehensive, easy-to-scan notes in Markdown. Priorities, in order: factual accuracy, preservation of specifics, complete coverage of substantive topics, clear decisions and action items, concise presentation.

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

Return only the finished Markdown notes.`;

const FOLLOW_UP_EMAIL_PROMPT = `You are an expert at writing follow-up emails after meetings. Draft the follow-up email the user ("You") would send to the other participants, based only on the provided meeting material: meeting context, the user's manual notes, and the transcript.

RULES:
- Use only information supported by the material. Do not invent facts, decisions, owners, deadlines, or names.
- Preserve the exact names of people, clients, projects, products, numbers, dates, and documents.
- Distinguish what was decided from what was proposed or still open.
- Write in the first person as the user, addressed to the other participants. Professional and warm, no filler.
- Keep it short: a two-sentence opener, then the substance, then a clear close. Aim for under 250 words.
- Use [brackets] for anything the email needs that the material does not supply, such as a recipient name.

FORMAT:
Subject: <a specific subject line>

<greeting>

<one short paragraph recapping the purpose and the main outcome>

Decisions
- <one bullet per decision that was clearly agreed>

Next steps
- <Owner> — <action> — <due date, or "date to confirm">

Open questions
- <one bullet per unresolved item, if any>

<sign-off as the user>

Omit any section that has no supported content. Return only the email.`;

export const BUILTIN_ACTIONS = [
  {
    translationKey: GENERATE_NOTES_KEY,
    name: "Generate Notes",
    description: "Clean up, structure, and enhance your notes",
    prompt: GENERATE_NOTES_PROMPT,
    // A pre-release build briefly shipped the detailed prompt under this key.
    previousPrompts: [DETAILED_NOTES_PROMPT_1_10_0],
    icon: "sparkles",
    sortOrder: 0,
  },
  {
    translationKey: DETAILED_NOTES_KEY,
    name: "Detailed Notes",
    description: "Accurate, comprehensive meeting notes with decisions and action items",
    prompt: DETAILED_NOTES_PROMPT,
    previousPrompts: [DETAILED_NOTES_PROMPT_1_10_0],
    icon: "sparkles",
    sortOrder: 1,
  },
  {
    translationKey: FOLLOW_UP_EMAIL_KEY,
    name: "Follow-up email",
    description: "Draft a follow-up email from your notes and transcript",
    prompt: FOLLOW_UP_EMAIL_PROMPT,
    previousPrompts: [],
    icon: "mail",
    sortOrder: 2,
  },
];

// Built-ins whose prompt is a complete instruction set and must not be wrapped
// in the generic system prompts.
export const STANDALONE_PROMPT_KEYS = new Set([DETAILED_NOTES_KEY, FOLLOW_UP_EMAIL_KEY]);
