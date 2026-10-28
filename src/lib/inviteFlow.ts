import type { InviteErrorKind, InviteFailure } from "./workspaceErrors";
import type { InviteOutcome } from "../services/invitePeople";
import { parseAddressList } from "../utils/emailApprovalFields";
import { EMAIL_REGEX } from "../utils/validation";

export const MAX_INVITE_RECIPIENTS = 100;

export type RecipientState =
  | { status: "draft" }
  | { status: "invalid" }
  | { status: "blocked"; reason: "alreadyMember" | "alreadyInvited" }
  | { status: "sending" }
  | ({ status: "failed" } & InviteFailure);

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
  /** Invitations the workspace can still take; null while unknown, which never warns or blocks. */
  seats: InviteSeats;
}

export interface InviteSeats {
  /** Purchased seats left. Going over only warns: the server bills a seat when the invite is accepted. */
  purchasedLeft: number | null;
  /** Room left under the seat ceiling. The server refuses invitations past it. */
  ceilingLeft: number | null;
}

export type InviteFlowEvent =
  | { type: "draft"; text: string }
  | { type: "commit" }
  | { type: "add"; email: string }
  | { type: "remove"; email: string }
  | { type: "role"; role: "admin" | "member" }
  | { type: "roster"; memberEmails: string[]; invitedEmails: string[] }
  | ({ type: "seats" } & InviteSeats)
  | { type: "send" }
  | { type: "result"; email: string; outcome: InviteOutcome }
  | { type: "finished" };

export interface SeatShortfall {
  available: number;
  excess: number;
}

export interface InviteSummary {
  sendable: string[];
  canSend: boolean;
  tooMany: boolean;
  invalid: InviteRecipient[];
  /** Members and pending invitations: never sent, and they never block sending. */
  skipped: InviteRecipient[];
  /** A warning only. */
  overSeats: SeatShortfall | null;
  overCeiling: SeatShortfall | null;
  failed: InviteRecipient[];
  noEmailCount: number;
}

// Commas as typed in every locale and semicolons are what `parseAddressList` splits on; a line
// break separates the rows of a pasted column.
const HARD_SEPARATOR = /[,;،，、\n\r]/;
// An address followed by a space is complete. A space anywhere else may belong to a name being
// searched for, or to a pasted "Name <address>" that isn't closed yet.
const ADDRESS_THEN_SPACE = /^\s*([^\s<>,;،，、]*@[^\s<>,;،，、]*)\s+/;
const CLOSED_DISPLAY_NAME = />\s*$/;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately loose: the server has the final say on what an address is.
function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/** The addresses in pasted or typed text, with any "Name <address>" reduced to its address. */
function parseEmails(text: string): string[] {
  const emails: string[] = [];
  for (const line of text.split(/[\n\r]+/)) {
    for (const part of parseAddressList(line)) {
      const words = part.split(/\s+/).filter(Boolean);
      // "a@x.com b@y.com" is two addresses; anything else stays whole, so a stray name is one
      // chip to remove rather than one per word.
      const addresses =
        words.length > 1 && words.every((word) => word.includes("@")) ? words : [part];
      emails.push(...addresses.map(normalize).filter((email) => email.length > 0));
    }
  }
  return emails;
}

function classify(email: string, memberEmails: string[], invitedEmails: string[]): RecipientState {
  if (!isValidEmail(email)) return { status: "invalid" };
  if (memberEmails.includes(email)) return { status: "blocked", reason: "alreadyMember" };
  if (invitedEmails.includes(email)) return { status: "blocked", reason: "alreadyInvited" };
  return { status: "draft" };
}

// A sent address comes back blocked as already invited, so re-adding it can't invite the same
// person twice and doesn't vanish without a word.
function addEmails(state: InviteFlowState, candidates: string[]): InviteFlowState {
  const known = new Set(state.recipients.map((recipient) => recipient.email));
  const sentEmails = new Set(state.sent.map((entry) => entry.email));
  const added: InviteRecipient[] = [];
  for (const candidate of candidates) {
    const email = normalize(candidate);
    if (!email || known.has(email)) continue;
    known.add(email);
    added.push({
      email,
      state: sentEmails.has(email)
        ? { status: "blocked", reason: "alreadyInvited" }
        : classify(email, state.memberEmails, state.invitedEmails),
    });
  }
  return added.length === 0 ? state : { ...state, recipients: [...state.recipients, ...added] };
}

function commitDraft(state: InviteFlowState): InviteFlowState {
  const withChips = addEmails(state, parseEmails(state.draft));
  return withChips.draft === "" ? withChips : { ...withChips, draft: "" };
}

function setDraft(state: InviteFlowState, text: string): InviteFlowState {
  if (CLOSED_DISPLAY_NAME.test(text)) return { ...addEmails(state, parseEmails(text)), draft: "" };

  // Everything up to the last separator is complete; only the fragment after it stays editable.
  let complete = "";
  let rest = text;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (HARD_SEPARATOR.test(text[index])) {
      complete = text.slice(0, index + 1);
      rest = text.slice(index + 1);
      break;
    }
  }
  const typed: string[] = [];
  for (let match = rest.match(ADDRESS_THEN_SPACE); match; match = rest.match(ADDRESS_THEN_SPACE)) {
    typed.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  if (complete === "" && typed.length === 0) return { ...state, draft: text };
  const withChips = addEmails(state, [...parseEmails(complete), ...typed]);
  return { ...withChips, draft: rest.trimStart() };
}

function shortfall(left: number | null, requested: number): SeatShortfall | null {
  if (left === null || requested <= left) return null;
  const available = Math.max(0, left);
  return { available, excess: requested - available };
}

// Only blocked chips are left, so there is nothing more to send or fix.
function isSettled(recipients: InviteRecipient[]): boolean {
  return recipients.every((recipient) => recipient.state.status === "blocked");
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

  let next: RecipientState;
  if (outcome.kind === "invalid") next = { status: "invalid" };
  else if (outcome.kind === "alreadyMember" || outcome.kind === "alreadyInvited") {
    next = { status: "blocked", reason: outcome.kind };
  } else if (outcome.kind === "refused") {
    next = { status: "failed", kind: "refused", message: outcome.message };
  } else next = { status: "failed", kind: outcome.kind };

  // A seat refusal means the batch went past the ceiling, so its count is the room that is left.
  const seats =
    outcome.kind === "seatLimit" && typeof outcome.available === "number"
      ? { ...state.seats, ceilingLeft: outcome.available }
      : state.seats;

  return {
    ...state,
    seats,
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
    seats: { purchasedLeft: null, ceilingLeft: null },
  };
  const initialEmail = input.initialEmail?.trim() ?? "";
  if (!initialEmail) return base;
  // A caller can pass a half-typed address (a roster search for "john@acme"); a chip could only
  // be removed, so it stays in the field to finish.
  return isValidEmail(normalize(initialEmail))
    ? addEmails(base, [initialEmail])
    : { ...base, draft: initialEmail };
}

/**
 * Whether sending the same request again can succeed. Every other failure is the server's
 * answer for this address or this workspace, so its chip waits to be removed.
 */
export function isRetryableFailure(kind: InviteErrorKind): boolean {
  return kind === "requestFailed" || kind === "sessionExpired" || kind === "rateLimited";
}

export function inviteSummary(state: InviteFlowState): InviteSummary {
  const sendable = state.recipients
    .filter(
      ({ state: chip }) =>
        chip.status === "draft" || (chip.status === "failed" && isRetryableFailure(chip.kind))
    )
    .map((recipient) => recipient.email);
  const draftText = normalize(state.draft);
  const draftAllowsSend = draftText === "" || isValidEmail(draftText);
  // Send commits the field first, so a valid address typed but not yet chipped counts: otherwise
  // the button would stay disabled for someone who typed one address and never pressed Enter. One
  // that would become a skipped chip adds nothing to send.
  const draftAddsChip =
    draftText !== "" &&
    draftAllowsSend &&
    !state.recipients.some((recipient) => recipient.email === draftText) &&
    !state.sent.some((entry) => entry.email === draftText) &&
    classify(draftText, state.memberEmails, state.invitedEmails).status === "draft";
  if (draftAddsChip) sendable.push(draftText);
  const invalid = state.recipients.filter(({ state: chip }) => chip.status === "invalid");
  const skipped = state.recipients.filter(({ state: chip }) => chip.status === "blocked");
  const failed = state.recipients.filter(({ state: chip }) => chip.status === "failed");
  const tooMany =
    state.recipients.length - skipped.length + (draftAddsChip ? 1 : 0) > MAX_INVITE_RECIPIENTS;
  const overSeats = shortfall(state.seats.purchasedLeft, sendable.length);
  const overCeiling = shortfall(state.seats.ceilingLeft, sendable.length);

  return {
    sendable,
    canSend:
      state.phase === "editing" &&
      sendable.length > 0 &&
      invalid.length === 0 &&
      !tooMany &&
      overCeiling === null &&
      draftAllowsSend,
    tooMany,
    invalid,
    skipped,
    overSeats,
    overCeiling,
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
      return { ...state, recipients, phase: isSettled(recipients) ? "done" : "editing" };
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
        isSettled(recipients) &&
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
    case "seats":
      return {
        ...state,
        seats: { purchasedLeft: event.purchasedLeft, ceilingLeft: event.ceilingLeft },
      };
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
  contacts: Array<{ email: string; name?: string | null }>,
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
    suggestions.push({ email: contact.email, name: contact.name?.trim() || null });
  }
  return suggestions;
}
