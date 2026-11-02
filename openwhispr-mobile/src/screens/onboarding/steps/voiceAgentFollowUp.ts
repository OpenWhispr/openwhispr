// The composer brackets every fact it isn't given (composerPrompt.ts, rule 6), so the voice
// assistant step reads them from each draft and says exactly what to fill in.
const PLACEHOLDER = /\[([^[\]\n]{1,40})\]/g;

// Past three, naming each one makes the instruction too long to read with the keyboard up.
const MAX_NAMED = 3;

export const DEFAULT_FOLLOW_UP =
  'Now tap Ask for changes and add a reason. Say: “Mention my paycheck comes in on Friday.”';

// What to say for the placeholders a message to a landlord usually has, checked in order. Contact
// details, the building and today's date get no script. A bare [Name] is the greeting, so it's the
// landlord; the tenant is the user. Anything else is named without a script.
const SAMPLE_ANSWERS: readonly { pattern: RegExp; answer?: string }[] = [
  { pattern: /unit|apartment|apt|address/i, answer: 'I’m in unit 4B' },
  { pattern: /phone|e-?mail|contact|building|today/i },
  { pattern: /landlord|property|manager|recipient|^name$/i, answer: 'my landlord is Maria' },
  { pattern: /tenant|sender|signature|\b(your|my)\b.*\bname\b/i, answer: 'sign it Alex' },
  { pattern: /due/i, answer: 'rent is due on the 1st' },
  { pattern: /date|day/i, answer: 'I can pay on the 3rd' },
  { pattern: /amount|total|\$/i, answer: 'it’s $1,500' },
];

// Each distinct placeholder in the draft, in order, without its brackets.
export function draftPlaceholders(draft: string): string[] {
  const found: string[] = [];
  for (const match of draft.matchAll(PLACEHOLDER)) {
    const label = match[1].trim();
    if (label && !found.some((seen) => seen.toLowerCase() === label.toLowerCase())) {
      found.push(label);
    }
  }
  return found;
}

// "a and b" for placeholders; spoken answers are clauses, so two of them take a comma too.
function listOf(items: string[], clauses = false): string {
  if (items.length < 2) return items.join('');
  if (items.length === 2) return items.join(clauses ? ', and ' : ' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function sampleAnswer(placeholder: string): string | undefined {
  return SAMPLE_ANSWERS.find(({ pattern }) => pattern.test(placeholder))?.answer;
}

// The instruction after a draft that still has placeholders. `again` is for a draft that came
// back from Ask for changes with some left; it can still be inserted as is.
export function fillInInstruction(placeholders: string[], again: boolean): string {
  const named = placeholders.length <= MAX_NAMED;
  const target = named
    ? listOf(placeholders.map((placeholder) => `[${placeholder}]`))
    : 'the parts in brackets';
  const lead = again
    ? `Still missing ${target}. Tap Ask for changes again.`
    : `Now tap Ask for changes and fill in ${target}.`;
  const answers = named ? placeholders.map(sampleAnswer) : [];
  let say = 'Say what goes there.';
  if (named && answers.every(Boolean)) {
    const spoken = listOf([...new Set(answers as string[])], true);
    say = `Say: “${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}.”`;
  }
  return again ? `${lead} ${say} Or tap ✓ to insert it as is.` : `${lead} ${say}`;
}
