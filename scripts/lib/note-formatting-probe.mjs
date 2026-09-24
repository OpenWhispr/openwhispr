/**
 * Fixture for the live note-formatting probe in scripts/llm-canary.mjs: a
 * meeting-sized transcript and the exact system prompt the note action store
 * sends for Detailed Notes, so the probe measures the request users make.
 */
import {
  BUILTIN_ACTIONS,
  DETAILED_NOTES_KEY,
  MEETING_INPUT_PREAMBLE,
} from "../../src/helpers/builtinActions.js";

/** A real 45-minute meeting lands around here; the 1.10.1 report was 2,170 words. */
export const NOTE_PROBE_MIN_WORDS = 2000;

const SPEAKERS = ["You", "Priya", "Marcus"];

// Sentence templates in agenda order. Placeholders are filled from a seeded
// generator so the transcript is deterministic yet not word-for-word repetitive.
const SENTENCES = [
  "Let's start with the beta rollout, since the {date1} milestone is the one leadership keeps asking about.",
  "We have {n1} customers in the beta cohort today and the plan was {n2} by {date1}.",
  "Support is seeing about {n3} tickets a day from the cohort, and most of them are about the export flow.",
  "I would rather slip the cohort target by a week than widen the beta while the export flow is in that state.",
  "Agreed, so the export fix comes first and we revisit the cohort number on {date2}.",
  "The export bug is the one where a workspace with more than {n4} notes times out halfway through the archive.",
  "I have a fix on a branch that streams the archive instead of building it in memory, and it needs a review.",
  "I can review it tomorrow morning, and I want a test that covers a workspace with {n5} notes before it merges.",
  "On pricing, finance signed off on {n6} dollars a seat for the team tier, with the annual discount at {pct1} percent.",
  "That is higher than the {n7} dollars we floated in the survey, so the launch copy needs to explain what the tier adds.",
  "The team tier adds shared spaces, the admin roster and the audit log, which is what the {n8} enterprise trials asked for.",
  "Then the copy should lead with shared spaces, because that is the feature every trial mentioned first.",
  "Marketing wants the pricing page live {n9} days before launch so the announcement can link to it.",
  "That means the page has to be final by {date3}, which is tight but doable if legal returns the terms this week.",
  "Legal said {date4} for the terms, and I will chase them if nothing arrives by then.",
  "Let's talk about the Windows microphone issue, because it is still the top complaint in the community forum.",
  "The fix that pins the default device is in the release candidate and {n10} of the {n11} reporters confirmed it works.",
  "The remaining reporters are on machines with a virtual audio cable, which we do not detect as a real device.",
  "I think we ship the fix as is and document the virtual cable case, rather than hold the release for it.",
  "Fine with me, as long as the release notes say it plainly instead of burying it in a known issues list.",
  "Next is the meeting transcription accuracy work; the diarization change moved the error rate from {pct2} to {pct3} percent.",
  "That is a solid improvement, but it costs about {n12} percent more processing time on the local path.",
  "On a laptop that means a {n13}-minute meeting takes roughly {n14} seconds longer to finish, which nobody will notice.",
  "The cloud path is unchanged, so the only people affected are those who chose local processing on purpose.",
  "Then we keep it, and I will add the accuracy numbers to the changelog so the trade-off is visible.",
  "We should also decide what to do about the onboarding drop-off between the permissions step and the first dictation.",
  "The funnel shows {pct4} percent of new users leave at the accessibility permission, mostly on macOS.",
  "Most of them never granted it because the system dialog opens behind our window on the newer OS versions.",
  "I have a change that brings the settings pane to the front and polls for the grant, and it needs a designer's eye on the copy.",
  "I can look at the copy this afternoon, and let's ship it in the same release since it is a two-line change.",
  "Let's go through the hiring update, because the backend role has been open for {n15} weeks now.",
  "We have {n16} candidates in the final round, and two of them are strong on the audio pipeline work we need.",
  "I would like to make an offer by {date5}, and I need the compensation band confirmed before I do.",
  "The band was approved at the last planning meeting, so you can move ahead as soon as the references come back.",
  "On support load, response times went from {n17} hours to {n18} hours after the macro cleanup, which is the best we have had.",
  "The macros still point to the old settings layout in {n19} places, and I will fix those before the release goes out.",
  "One more thing on the release itself: the auto-updater staged rollout should start at {pct5} percent this time.",
  "Last release we went straight to everyone and the Linux crash reached {n20} users before we could pause it.",
  "So {pct5} percent for the first day, then {pct6} percent if the crash rate stays flat, then everyone.",
  "I will set that up in the release pipeline and add the crash-rate check to the go/no-go checklist.",
  "Before we close, the customer advisory call is on {date6} and I want three customers from the beta on it.",
  "I can invite the two design agencies and the law firm, since they gave the most detailed feedback so far.",
  "Good, send the invites today so they have two weeks' notice, and add the questions doc to the calendar entry.",
  "To recap, export fix first, pricing page by {date3}, Windows fix ships with a documented caveat, and staged rollout at {pct5} percent.",
  "I will write this up and send it to the channel within the hour so nobody has to rely on memory.",
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = ["March", "April", "May", "June", "July", "September", "October"];

function fillPlaceholders(template, random) {
  return template.replace(/\{(n|pct|date)(\d+)\}/g, (_match, kind) => {
    if (kind === "date") {
      const month = MONTHS[Math.floor(random() * MONTHS.length)];
      return `${month} ${1 + Math.floor(random() * 28)}`;
    }
    if (kind === "pct") return String(5 + Math.floor(random() * 60));
    return String(2 + Math.floor(random() * 400));
  });
}

export function countWords(text) {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * A deterministic meeting transcript in the note editor's layout, at least
 * NOTE_PROBE_MIN_WORDS long. Word count grows by cycling the agenda with fresh
 * numbers, which keeps the input meeting-shaped rather than a wall of the same
 * line.
 */
export function buildNoteProbeTranscript({ minWords = NOTE_PROBE_MIN_WORDS, seed = 1101 } = {}) {
  const random = seededRandom(seed);
  const header = [
    "## Meeting Context",
    "Note owner: You",
    "Participants: Priya, Marcus",
    "",
    "## Meeting Transcript",
  ].join("\n");
  const lines = [];
  let words = countWords(header);
  let index = 0;
  while (words < minWords) {
    const template = SENTENCES[index % SENTENCES.length];
    const speaker = SPEAKERS[index % SPEAKERS.length];
    const line = `${speaker}: ${fillPlaceholders(template, random)}`;
    lines.push(line);
    words += countWords(line);
    index += 1;
  }
  return `${header}\n${lines.join("\n")}\n`;
}

/** Exactly what actionProcessingStore sends for the built-in Detailed Notes action on a meeting note. */
export function buildNoteProbeSystemPrompt() {
  const action = BUILTIN_ACTIONS.find((entry) => entry.translationKey === DETAILED_NOTES_KEY);
  if (!action) throw new Error("Detailed Notes is no longer a built-in action");
  return MEETING_INPUT_PREAMBLE + action.prompt;
}
