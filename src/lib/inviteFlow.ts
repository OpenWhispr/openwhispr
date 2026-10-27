import type { InviteErrorKind } from "./workspaceErrors";
import type { InviteOutcome } from "../services/invitePeople";

export const MAX_INVITE_RECIPIENTS = 20;

export type RecipientState =
  | { status: "draft" }
  | { status: "invalid" }
  | { status: "blocked"; reason: "alreadyMember" | "alreadyInvited" }
  | { status: "sending" }
  | { status: "failed"; kind: InviteErrorKind };

export interface InviteRecipient {
  email: string;
  state: RecipientState;
}

export interface InviteFlowState {
  draft: string;
  /** Never holds sent addresses: a sent chip leaves for `sent`. */
  recipients: InviteRecipient[];
  role: "admin" | "member";
  phase: "editing" | "sending" | "done";
  /** Accumulates across retries. */
  sent: Array<{ email: string; emailSent: boolean }>;
  memberEmails: string[];
  invitedEmails: string[];
}

export type InviteFlowEvent =
  | { type: "draft"; text: string }
  | { type: "commit" }
  | { type: "add"; email: string }
  | { type: "remove"; email: string }
  | { type: "role"; role: "admin" | "member" }
  | { type: "roster"; memberEmails: string[]; invitedEmails: string[] }
  | { type: "send" }
  | { type: "result"; email: string; outcome: InviteOutcome }
  | { type: "finished" };

export interface InviteSummary {
  sendable: string[];
  canSend: boolean;
  tooMany: boolean;
  invalid: InviteRecipient[];
  blocked: InviteRecipient[];
  failed: InviteRecipient[];
  noEmailCount: number;
}

const SEPARATOR = /[,;\s]/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export function splitEmails(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map(normalize)
    .filter((email) => email.length > 0);
}

// Deliberately loose: the server has the final say on what an address is.
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

function classify(email: string, memberEmails: string[], invitedEmails: string[]): RecipientState {
  if (!isValidEmail(email)) return { status: "invalid" };
  if (memberEmails.includes(email)) return { status: "blocked", reason: "alreadyMember" };
  if (invitedEmails.includes(email)) return { status: "blocked", reason: "alreadyInvited" };
  return { status: "draft" };
}

// A sent address is skipped too, so re-adding it cannot invite the same person twice.
function addEmails(state: InviteFlowState, candidates: string[]): InviteFlowState {
  const known = new Set([
    ...state.recipients.map((recipient) => recipient.email),
    ...state.sent.map((entry) => entry.email),
  ]);
  const added: InviteRecipient[] = [];
  for (const candidate of candidates) {
    const email = normalize(candidate);
    if (!email || known.has(email)) continue;
    known.add(email);
    added.push({ email, state: classify(email, state.memberEmails, state.invitedEmails) });
  }
  return added.length === 0 ? state : { ...state, recipients: [...state.recipients, ...added] };
}

function commitDraft(state: InviteFlowState): InviteFlowState {
  const withChips = addEmails(state, splitEmails(state.draft));
  return withChips.draft === "" ? withChips : { ...withChips, draft: "" };
}

function setDraft(state: InviteFlowState, text: string): InviteFlowState {
  // Everything up to the last separator is complete; only the fragment after it stays editable.
  let lastSeparator = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (SEPARATOR.test(text[index])) {
      lastSeparator = index;
      break;
    }
  }
  if (lastSeparator === -1) return { ...state, draft: text };
  const withChips = addEmails(state, splitEmails(text.slice(0, lastSeparator + 1)));
  return { ...withChips, draft: text.slice(lastSeparator + 1) };
}

function resolveResult(
  state: InviteFlowState,
  email: string,
  outcome: InviteOutcome
): InviteFlowState {
  const target = normalize(email);
  const chip = state.recipients.find((recipient) => recipient.email === target);
  if (!chip) return state;

  // `=== true` / `=== false` rather than truthiness: src compiles without strictNullChecks,
  // where a bare `ok` check does not narrow the union.
  if (outcome.ok === true) {
    return {
      ...state,
      recipients: state.recipients.filter((recipient) => recipient !== chip),
      sent: [...state.sent, { email: target, emailSent: outcome.emailSent }],
    };
  }

  const { kind } = outcome;
  let next: RecipientState;
  if (kind === "invalid") next = { status: "invalid" };
  else if (kind === "alreadyMember" || kind === "alreadyInvited") {
    next = { status: "blocked", reason: kind };
  } else next = { status: "failed", kind };

  return {
    ...state,
    recipients: state.recipients.map((recipient) =>
      recipient === chip ? { email: recipient.email, state: next } : recipient
    ),
  };
}

export function createInviteFlow(input: { initialEmail?: string }): InviteFlowState {
  const base: InviteFlowState = {
    draft: "",
    recipients: [],
    role: "member",
    phase: "editing",
    sent: [],
    memberEmails: [],
    invitedEmails: [],
  };
  return input.initialEmail ? addEmails(base, [input.initialEmail]) : base;
}

export function inviteSummary(state: InviteFlowState): InviteSummary {
  const sendable = state.recipients
    .filter(({ state: chip }) => chip.status === "draft" || chip.status === "failed")
    .map((recipient) => recipient.email);
  const draftText = normalize(state.draft);
  const draftAllowsSend = draftText === "" || isValidEmail(draftText);
  // Send commits the field first, so a valid address typed but not yet chipped counts: otherwise
  // the button would stay disabled for someone who typed one address and never pressed Enter.
  if (
    draftText !== "" &&
    draftAllowsSend &&
    !state.recipients.some((recipient) => recipient.email === draftText) &&
    !state.sent.some((entry) => entry.email === draftText)
  ) {
    sendable.push(draftText);
  }
  const invalid = state.recipients.filter(({ state: chip }) => chip.status === "invalid");
  const blocked = state.recipients.filter(({ state: chip }) => chip.status === "blocked");
  const failed = state.recipients.filter(({ state: chip }) => chip.status === "failed");
  const tooMany = state.recipients.length > MAX_INVITE_RECIPIENTS;

  return {
    sendable,
    canSend:
      state.phase === "editing" &&
      sendable.length > 0 &&
      invalid.length === 0 &&
      blocked.length === 0 &&
      !tooMany &&
      draftAllowsSend,
    tooMany,
    invalid,
    blocked,
    failed,
    noEmailCount: state.sent.filter((entry) => !entry.emailSent).length,
  };
}

export function inviteReducer(state: InviteFlowState, event: InviteFlowEvent): InviteFlowState {
  if (state.phase === "sending") {
    if (event.type === "result") return resolveResult(state, event.email, event.outcome);
    if (event.type === "finished") {
      // A chip the run never answered would otherwise stay "sending" and never be sendable again.
      const recipients = state.recipients.map((recipient): InviteRecipient =>
        recipient.state.status === "sending"
          ? { email: recipient.email, state: { status: "failed", kind: "requestFailed" } }
          : recipient
      );
      return { ...state, recipients, phase: recipients.length === 0 ? "done" : "editing" };
    }
    return state;
  }

  switch (event.type) {
    case "draft":
      return setDraft(state, event.text);
    case "commit":
      return commitDraft(state);
    case "add":
      return addEmails(state, [event.email]);
    case "remove": {
      const target = normalize(event.email);
      if (!state.recipients.some((recipient) => recipient.email === target)) return state;
      const recipients = state.recipients.filter((recipient) => recipient.email !== target);
      // Removing the last failed chip of a partial send must still confirm the invitations that
      // went out, and warn about any whose email wasn't delivered.
      const settled =
        state.phase === "editing" &&
        recipients.length === 0 &&
        state.draft === "" &&
        state.sent.length > 0;
      return { ...state, recipients, phase: settled ? "done" : state.phase };
    }
    case "role":
      return { ...state, role: event.role };
    case "roster": {
      const memberEmails = event.memberEmails.map(normalize);
      const invitedEmails = event.invitedEmails.map(normalize);
      return {
        ...state,
        memberEmails,
        invitedEmails,
        // Only untouched chips are re-judged; a server verdict on a failed or blocked chip stands.
        recipients: state.recipients.map((recipient) =>
          recipient.state.status === "draft"
            ? {
                email: recipient.email,
                state: classify(recipient.email, memberEmails, invitedEmails),
              }
            : recipient
        ),
      };
    }
    case "send": {
      const committed = commitDraft(state);
      const summary = inviteSummary(committed);
      if (!summary.canSend) return committed;
      const sendingEmails = new Set(summary.sendable);
      return {
        ...committed,
        phase: "sending",
        recipients: committed.recipients.map((recipient) =>
          sendingEmails.has(recipient.email)
            ? { email: recipient.email, state: { status: "sending" } }
            : recipient
        ),
      };
    }
    case "result":
    case "finished":
      return state;
  }
}

export function inviteSuggestions(
  contacts: Array<{ email: string; display_name?: string | null }>,
  exclude: string[],
  limit = 5
): Array<{ email: string; name: string | null }> {
  const skipped = new Set(exclude.map(normalize));
  const suggestions: Array<{ email: string; name: string | null }> = [];
  for (const contact of contacts) {
    if (suggestions.length >= limit) break;
    const key = normalize(contact.email);
    if (!key || skipped.has(key)) continue;
    skipped.add(key);
    suggestions.push({ email: contact.email, name: contact.display_name?.trim() || null });
  }
  return suggestions;
}
