// Built-in note templates and actions. The database seeds any that are missing
// on startup and only rewrites a row whose prompt still equals a previous
// default, so a user's edited prompt is never touched. A template writes the AI
// summary: AI Summary, the default (Generate Notes' key), wraps its prompt in the
// generic system prompt, and Detailed Notes is compiled from sections (see
// templatePrompts.js). An action either edits the summary or answers in the note
// chat.

export const GENERATE_NOTES_KEY = "notes.actions.builtin.generateNotes";
export const DETAILED_NOTES_KEY = "notes.actions.builtin.detailedNotes";
export const FOLLOW_UP_EMAIL_KEY = "notes.actions.builtin.followUpEmail";

// Caps on a template's or action's fields, enforced when a row is saved. Keep
// them in step with the API's schemas once custom rows sync.
export const NOTE_ACTION_LIMITS = {
  name: 200,
  description: 1000,
  prompt: 20000,
  sections: 20,
  heading: 200,
  instruction: 2000,
};

const GENERATE_NOTES_PROMPT_1_10_1 =
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
const DETAILED_NOTES_PROMPT_1_10_1 = `Convert the provided material into accurate, comprehensive, easy-to-scan notes in Markdown. Priorities, in order: factual accuracy, preservation of specifics, complete coverage of substantive topics, clear decisions and action items, concise presentation.

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

// Shipped through 1.10.2: a note with nothing to summarize got a sentence saying
// so saved as its summary.
const NON_SUBSTANTIVE_NOTES_INSTRUCTIONS_1_10_2 = `For material with no substantive discussion or notes (for example, only greetings, filler, or recording checks), return one brief factual sentence describing what was captured. If nothing meaningful can be summarized, say "No substantive content was captured." in the requested output language. This rule overrides the section structure and bullet counts above: do not return an empty response or invent topics, decisions, or action items. Consider both the transcript and any manual notes before applying this rule.`;

/** A note run's reply when the material has nothing to summarize: the runner saves nothing and says so. */
export const NOTHING_TO_SUMMARIZE = "NOTHING_TO_SUMMARIZE";

// Omitting every unsupported section can otherwise produce a blank completion.
const NON_SUBSTANTIVE_NOTES_INSTRUCTIONS = `For material with no substantive discussion or notes (for example, only greetings, filler, or recording checks), reply with exactly ${NOTHING_TO_SUMMARIZE} and nothing else. This rule overrides the section structure and bullet counts above: do not return an empty response or invent topics, decisions, or action items. Consider both the transcript and any manual notes before applying this rule.`;

const GENERATE_NOTES_PROMPT_1_10_2 = `${GENERATE_NOTES_PROMPT_1_10_1}\n\n${NON_SUBSTANTIVE_NOTES_INSTRUCTIONS_1_10_2}`;
const GENERATE_NOTES_PROMPT = `${GENERATE_NOTES_PROMPT_1_10_1}\n\n${NON_SUBSTANTIVE_NOTES_INSTRUCTIONS}`;
// The last flat Detailed Notes prompt; a row still holding it moves to sections.
const DETAILED_NOTES_PROMPT_1_10_2 = `${DETAILED_NOTES_PROMPT_1_10_1}\n\n${NON_SUBSTANTIVE_NOTES_INSTRUCTIONS_1_10_2}`;

// A sectioned template is compiled from these rules, the template's own context,
// the format line, its sections, and the footer. Detailed Notes' sections compile
// back to DETAILED_NOTES_PROMPT_1_10_2 exactly, but for its closing rule (pinned by
// templatePrompts.test.js).
export const SECTIONED_NOTES_INSTRUCTIONS = `Convert the provided material into accurate, comprehensive, easy-to-scan notes in Markdown. Priorities, in order: factual accuracy, preservation of specifics, complete coverage of substantive topics, clear decisions and action items, concise presentation.

RULES:
- Use only information supported by the material. Never invent facts, decisions, owners, deadlines, or names.
- Keep the exact names of people, clients, companies, projects, products, tools, and acronyms, and the exact numbers, dates, deadlines, and document names. Never replace a named entity with a generic noun such as "the client" or "the project". If a name is unclear, write "[name unclear]" rather than guessing.
- Speech-to-text misspells names. When the transcript's spelling is an obvious variant of a name in the Meeting Context, the participants' email addresses, the manual notes, or the custom dictionary, use that spelling instead.
- Distinguish what was discussed, proposed, or requested from what was actually decided.
- Treat the user's manual notes as a signal of what matters most, reconciled against the transcript.
- Consolidate repeated discussion into one point. Drop greetings, filler, and false starts. Give longer meetings proportionally more detail.
- If there is no transcript, structure the user's own notes and skip the meeting-specific sections.`;

export const SECTIONED_NOTES_FORMAT = `FORMAT:
- No title, date, attendee list, preamble, table, or horizontal rule. Omit any section with nothing to say.`;

export const SECTIONED_NOTES_FOOTER = `Return only the finished Markdown notes.\n\n${NON_SUBSTANTIVE_NOTES_INSTRUCTIONS}`;

// Action items must end in "— Owner" so the editor can turn owners into
// mention chips (see tagActionItemOwners).
const ACTION_ITEMS_SECTION = {
  heading: "Action Items",
  instruction:
    'Only actions someone committed to or was asked to do; never turn a discussion topic into an action item. One checkbox per item in the form `- [ ] Action — Owner`. Put a stated due date inside the action text, for example `- [ ] Send the revised proposal by Friday — Alice`. The owner is the person the transcript shows taking the action on or being asked to, not whoever raised the topic; name them whenever the transcript shows it. Use "You" or "Them" only when no name is available. When the transcript shows no owner, end the line after the action; never write a placeholder such as "Owner not specified".',
};

const DETAILED_NOTES_SECTIONS = [
  {
    heading: "Summary",
    instruction: "3–5 bullets: purpose, key subjects, major outcomes, immediate next steps.",
  },
  {
    heading: "Discussion",
    instruction:
      "Descriptive topic subheadings named after the actual client, project, or initiative, with enough context that someone who missed the meeting understands what happened and why.",
  },
  {
    heading: "Decisions",
    instruction: "Only decisions that were explicitly made or clearly agreed.",
  },
  ACTION_ITEMS_SECTION,
  {
    heading: "Open Questions",
    instruction: "Unresolved questions, dependencies, and requested follow-ups.",
  },
];

const ONE_ON_ONE_CONTEXT =
  "A one-on-one, usually between a manager and someone on their team. Keep each person's updates, concerns, and feedback attributed to them, and leave out personal matters unless they bear on the work.";

const ONE_ON_ONE_SECTIONS = [
  {
    heading: "Summary",
    instruction: "2–3 bullets: what the conversation covered and where it landed.",
  },
  {
    heading: "Updates",
    instruction:
      "Progress, wins, and status changes each person shared, grouped by project or topic.",
  },
  {
    heading: "Challenges and Feedback",
    instruction:
      "Blockers, concerns, and feedback given in either direction, with the context behind each.",
  },
  {
    heading: "Growth and Goals",
    instruction: "Career, development, or goal discussion, and any support that was offered.",
  },
  ACTION_ITEMS_SECTION,
];

const STAND_UP_CONTEXT =
  "A short team stand-up. Keep every update to one or two bullets and skip small talk entirely.";

const STAND_UP_SECTIONS = [
  {
    heading: "Summary",
    instruction: "1–2 bullets on the team's overall progress and anything that needs attention.",
  },
  {
    heading: "Updates by Person",
    instruction:
      "One subheading per person, named by their label, with what they finished and what they are doing next.",
  },
  {
    heading: "Blockers",
    instruction: "Each blocker, who it affects, and who offered to help.",
  },
  ACTION_ITEMS_SECTION,
];

const SALES_CALL_CONTEXT =
  "A sales conversation with a prospect or customer. Write it for the seller who has to move the deal forward, and state every number, price, and date exactly.";

const SALES_CALL_SECTIONS = [
  {
    heading: "Summary",
    instruction:
      "3–5 bullets: who the prospect is, what they want, where the deal stands, and the agreed next step.",
  },
  {
    heading: "Customer Context",
    instruction:
      "The prospect's company, the attendees and their roles when stated, and their current situation and tools.",
  },
  {
    heading: "Needs and Pain Points",
    instruction: "What they are trying to solve and why it matters to them now.",
  },
  {
    heading: "Objections",
    instruction: "Each objection or concern raised, and how it was answered if it was.",
  },
  {
    heading: "Budget, Pricing, and Timeline",
    instruction: "Budget, pricing discussed, and deadlines or buying timeline.",
  },
  {
    heading: "Decision Process",
    instruction:
      "Who decides, their evaluation criteria, competitors mentioned, and approvals still needed.",
  },
  ACTION_ITEMS_SECTION,
];

const USER_INTERVIEW_CONTEXT =
  "A user research interview. Keep what the participant said and did separate from what the interviewer suggested, and never present the interviewer's ideas as findings.";

const USER_INTERVIEW_SECTIONS = [
  {
    heading: "Summary",
    instruction: "3–5 bullets: who the participant is and the most important things learned.",
  },
  {
    heading: "Participant Background",
    instruction: "Their role, context, and experience relevant to the interview.",
  },
  {
    heading: "Current Workflow",
    instruction: "How they do the job today, including tools and workarounds.",
  },
  {
    heading: "Pain Points",
    instruction: "Problems they described, how often they hit them, and what they cost them.",
  },
  {
    heading: "Reactions and Feedback",
    instruction: "Their reactions to any ideas, designs, or features shown, including hesitations.",
  },
  {
    heading: "Notable Quotes",
    instruction: "Short verbatim quotes that capture their perspective, attributed by label.",
  },
  {
    heading: "Follow-ups",
    instruction: "Open questions to explore next and anything promised to the participant.",
  },
];

const FOLLOW_UP_EMAIL_BODY = `RULES:
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

// Shipped in 1.10.1 and 1.10.2, when the email always read the transcript.
const FOLLOW_UP_EMAIL_PROMPT_1_10_2 = `You are an expert at writing follow-up emails after meetings. Draft the follow-up email the user ("You") would send to the other participants, based only on the provided meeting material: meeting context, the user's manual notes, and the transcript.\n\n${FOLLOW_UP_EMAIL_BODY}`;

const FOLLOW_UP_EMAIL_PROMPT = `You are an expert at writing follow-up emails after meetings. Draft the follow-up email the user ("You") would send to the other participants, based only on the meeting material you are working from.\n\n${FOLLOW_UP_EMAIL_BODY}`;

const MAKE_TODOS_PROMPT = `List the to-dos in this note: every action someone committed to or was asked to do, based only on what the note supports. One checkbox per item in the form \`- [ ] Action — Owner\`, with any stated due date inside the action text. Leave the owner out when the note does not show one. If there are no to-dos, say so in one sentence.`;

const CREATE_OUTLINE_PROMPT = `Outline this note, based only on what it says. Use nested Markdown bullets: one top-level bullet per main topic in the order it came up, with its key points, decisions, and numbers beneath it. Return only the outline.`;

const SLACK_UPDATE_PROMPT = `Write a short Slack message I can post to my team about this meeting: one line on what it was about, then 3–5 bullets with the outcomes, decisions, and who is doing what next. Use Slack formatting (bold with *asterisks*, no Markdown headings), keep it under 120 words, and use only what the note supports. Return only the message.`;

const SHORTEN_PROMPT = `Make it about half as long. Keep every decision, number, date, name, and action item; cut repetition, background, and detail that would not change what anyone does next.`;

const ADD_TLDR_PROMPT = `Add a "## TL;DR" section at the very top: two or three sentences on what the meeting decided and what happens next. Leave the rest of the summary exactly as it is.`;

// System-prompt wrappers the note action store puts around a built-in or
// custom action prompt. They live here, with the action prompts, so the live
// canary can send the exact request the app sends.
export const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use horizontal rules or block quotes. Use a table only when the instructions ask for one.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

export const MEETING_SYSTEM_PROMPT = `You are a professional meeting notes assistant. You will receive a meeting transcript where each line is prefixed with the speaker's label — a real name when known, otherwise "You" (the note owner), "Them", or "Speaker N". A "## Meeting Context" block may identify the note owner and the invited participants. Manual notes the user took may be included as well.

Your job is to produce clean, actionable meeting notes in markdown. Follow these rules:

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no "# Meeting Notes", no date/time/location, no attendee list, no topic header. Start directly with the summary.
- Do NOT reproduce the Meeting Context block in the output.
- Do NOT use horizontal rules or block quotes. Use a table only when the instructions ask for one.
- Refer to people only by the speaker labels used in the transcript. NEVER guess or invent an identity: the note owner is who the Meeting Context says they are — never a name mentioned in conversation. Keep unnamed speakers as "Them" or "Speaker N".
- Start with a concise 1–2 sentence summary of what the meeting was about.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes in the format \`- [ ] Action — Owner\`, attributing each item to its owner by speaker label where clear.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

// Sectioned and standalone templates are complete instructions, so they only get
// told how the material is laid out instead of being wrapped in the generic prompts.
export const MEETING_INPUT_PREAMBLE = `The material is laid out as follows. Transcript lines are prefixed with the speaker's label: a real name when known, otherwise "You" (the note owner), "Them", or "Speaker N". A "## Meeting Context" block may identify the note owner and the invited participants; it is reference material, never something to reproduce. Manual notes the user took may precede the transcript.

`;
export const NOTE_INPUT_PREAMBLE = `The material is the user's own notes, possibly voice-transcribed, rough, or unstructured. There is no transcript.

`;

// A summary action rewrites the summary the note already has; the rest of the
// input is only there to keep the rewrite accurate.
export const SUMMARY_ACTION_SYSTEM_PROMPT = `You revise an existing AI summary of a note. The input starts with the current summary under "## Current Summary". The user's own notes under "## My Notes" and a "## Meeting Context" block may follow; they are reference material for accuracy, never something to reproduce.

Apply the instructions below to the current summary and return the complete revised summary in Markdown, with no preamble and no code fences. Unless the instructions say otherwise, keep its facts, names, numbers, headings, and \`- [ ] Action — Owner\` items, and add nothing the summary or the reference material does not support.

Instructions: `;

// With no summary to edit, a summary action writes one from the material first.
export const SUMMARY_ACTION_FROM_MATERIAL_PROMPT = `The note has no AI summary yet. Write concise, accurate notes of the material in Markdown (no title or preamble, and only what the material supports, with action items as \`- [ ] Action — Owner\`), apply the instructions below to them, and return the result. It becomes the note's AI summary. If the material has no substantive discussion or notes (for example, only greetings, filler, or recording checks), reply with exactly ${NOTHING_TO_SUMMARIZE} and nothing else.

Instructions: `;

// A chat action is sent as the user's turn in the note chat, whose system prompt
// already carries the whole note. It works from the AI summary when there is one.
// The note chat can offer connector tools; a one-click action answers in the chat.
const CHAT_ACTION_ANSWER_RULE =
  "Write your answer here in the chat as text. Don't use a tool to draft, send or post it, unless the instructions explicitly ask you to send, post or file something. Answer in the language the note is written in, not the language of these instructions.";
export const CHAT_ACTION_ON_SUMMARY_PREAMBLE = `Work from the AI summary of the note I'm viewing (it's in your context), and use its transcript only if the instructions below ask for it. ${CHAT_ACTION_ANSWER_RULE} Follow these instructions:

`;
export const CHAT_ACTION_ON_MATERIAL_PREAMBLE = `The note I'm viewing has no AI summary yet, so work from its transcript and notes (they're in your context). ${CHAT_ACTION_ANSWER_RULE} Follow these instructions:

`;

/**
 * Output budget for a formatted note.
 *
 * Without an explicit value this inherited the generic 2048-token default from
 * calculateMaxTokens — roughly 1,500 words — so summaries of long meetings were
 * cut off and saved anyway, with nothing to say they were incomplete (#2142).
 *
 * Deliberately not paired with requireCompleteOutput: unlike a selection edit,
 * where a partial replacement corrupts the user's own text, a clipped summary
 * is still worth keeping. The context preflight counts this reservation, so
 * asking for more output room can grow the window rather than squeeze it.
 */
export const NOTE_OUTPUT_MAX_TOKENS = 4096;

// Built-ins added once templates had sections; none has an older default to upgrade.
const builtinTemplate = ({ key, name, description, prompt, sections, sortOrder }) => ({
  translationKey: `notes.actions.builtin.${key}`,
  kind: "template",
  name,
  description,
  prompt,
  sections,
  output: null,
  previousPrompts: [],
  icon: "sparkles",
  sortOrder,
});

const builtinAction = ({
  key,
  name,
  description,
  prompt,
  output,
  icon = "sparkles",
  sortOrder,
}) => ({
  translationKey: `notes.actions.builtin.${key}`,
  kind: "action",
  name,
  description,
  prompt,
  sections: null,
  output,
  previousPrompts: [],
  icon,
  sortOrder,
});

// previousPrompts only upgrades a row that is still a flat prompt; a later change
// to a built-in's default sections needs its own history.
export const BUILTIN_ACTIONS = [
  {
    translationKey: DETAILED_NOTES_KEY,
    kind: "template",
    // The prompt 1.10.2's Generate AI Summary button used.
    name: "Detailed Notes",
    description: "Accurate, comprehensive meeting notes with decisions and action items",
    prompt: "",
    sections: DETAILED_NOTES_SECTIONS,
    output: null,
    previousPrompts: [
      DETAILED_NOTES_PROMPT_1_10_0,
      DETAILED_NOTES_PROMPT_1_10_1,
      DETAILED_NOTES_PROMPT_1_10_2,
    ],
    icon: "sparkles",
    sortOrder: 1,
  },
  {
    translationKey: GENERATE_NOTES_KEY,
    kind: "template",
    // The default template.
    name: "AI Summary",
    description: "Clean up, structure, and enhance your notes",
    prompt: GENERATE_NOTES_PROMPT,
    sections: null,
    output: null,
    // A pre-release build briefly shipped the detailed prompt under this key.
    previousPrompts: [
      DETAILED_NOTES_PROMPT_1_10_0,
      GENERATE_NOTES_PROMPT_1_10_1,
      GENERATE_NOTES_PROMPT_1_10_2,
    ],
    icon: "sparkles",
    sortOrder: 0,
  },
  {
    translationKey: FOLLOW_UP_EMAIL_KEY,
    kind: "action",
    name: "Follow-up email",
    description: "Draft a follow-up email from your notes and transcript",
    prompt: FOLLOW_UP_EMAIL_PROMPT,
    sections: null,
    output: "chat",
    previousPrompts: [FOLLOW_UP_EMAIL_PROMPT_1_10_2],
    icon: "mail",
    sortOrder: 2,
  },
  builtinAction({
    key: "makeTodos",
    name: "Create to-dos",
    description: "List every to-do and its owner in the chat",
    prompt: MAKE_TODOS_PROMPT,
    output: "chat",
    icon: "clipboard-check",
    sortOrder: 3,
  }),
  builtinAction({
    key: "shorten",
    name: "Shorten",
    description: "Make the summary about half as long",
    prompt: SHORTEN_PROMPT,
    output: "summary",
    sortOrder: 4,
  }),
  builtinAction({
    key: "addTldr",
    name: "Add TL;DR",
    description: "Put a two- or three-sentence TL;DR at the top of the summary",
    prompt: ADD_TLDR_PROMPT,
    output: "summary",
    sortOrder: 5,
  }),
  builtinAction({
    key: "createOutline",
    name: "Create outline",
    description: "Outline the note's topics in the chat",
    prompt: CREATE_OUTLINE_PROMPT,
    output: "chat",
    icon: "file-text",
    sortOrder: 6,
  }),
  builtinAction({
    key: "slackUpdate",
    name: "Slack update",
    description: "Write a short team update to post in Slack",
    prompt: SLACK_UPDATE_PROMPT,
    output: "chat",
    icon: "send",
    sortOrder: 7,
  }),
  builtinTemplate({
    key: "oneOnOne",
    name: "1:1",
    description: "Updates, feedback, growth, and next steps from a one-on-one",
    prompt: ONE_ON_ONE_CONTEXT,
    sections: ONE_ON_ONE_SECTIONS,
    sortOrder: 8,
  }),
  builtinTemplate({
    key: "standUp",
    name: "Stand-up",
    description: "Each person's progress, plans, and blockers",
    prompt: STAND_UP_CONTEXT,
    sections: STAND_UP_SECTIONS,
    sortOrder: 9,
  }),
  builtinTemplate({
    key: "salesCall",
    name: "Sales call",
    description: "Needs, objections, budget, and the decision process",
    prompt: SALES_CALL_CONTEXT,
    sections: SALES_CALL_SECTIONS,
    sortOrder: 10,
  }),
  builtinTemplate({
    key: "userInterview",
    name: "User interview",
    description: "Workflow, pain points, reactions, and quotes from a participant",
    prompt: USER_INTERVIEW_CONTEXT,
    sections: USER_INTERVIEW_SECTIONS,
    sortOrder: 11,
  }),
];

// A flat Detailed Notes prompt (one the user edited before templates had
// sections) is a complete instruction set and must not be wrapped in the
// generic system prompts.
export const STANDALONE_PROMPT_KEYS = new Set([DETAILED_NOTES_KEY]);
