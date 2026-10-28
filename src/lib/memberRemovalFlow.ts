import type { OwnedMemberContent, WorkspaceMember } from "../types/electron";
import type { RemovalError } from "./workspaceErrors";

// Pure state machine for removing one or more members. It checks who owns content before
// asking: with no owners it is a plain confirm, otherwise a new owner is picked (you, unless
// changed) and the content moves to them as the members are removed.
export type RemovalPhase = "checking" | "confirm" | "running" | "failed";

export type MemberRemovalState =
  | { kind: "closed" }
  | {
      kind: RemovalPhase;
      subjects: WorkspaceMember[];
      owners: OwnedMemberContent[];
      transferTo: string | null;
      defaultOwnerId: string;
      error?: RemovalError;
    };

export type MemberRemovalEvent =
  | { type: "open"; subjects: WorkspaceMember[]; defaultOwnerId: string }
  // The preview's entries; only those that own something are kept.
  | { type: "previewed"; owners: unknown }
  | { type: "previewFailed" }
  | { type: "pickOwner"; userId: string }
  | { type: "confirm" }
  | { type: "failed"; error: RemovalError }
  | { type: "succeeded" }
  | { type: "dismiss" };

type OpenState = Exclude<MemberRemovalState, { kind: "closed" }>;

const memberName = (member: WorkspaceMember): string => member.name || member.email;

// The server's lists reach here unchecked, so an entry that names nobody is dropped.
function isOwnerEntry(entry: unknown): entry is OwnedMemberContent {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { user_id?: unknown }).user_id === "string"
  );
}

const ownsContent = (owner: OwnedMemberContent): boolean =>
  owner.owned_notes > 0 || owner.owned_spaces > 0;

function confirmWith(state: OpenState, owners: OwnedMemberContent[]): OpenState {
  return {
    kind: "confirm",
    subjects: state.subjects,
    owners,
    transferTo: owners.length > 0 ? state.defaultOwnerId : null,
    defaultOwnerId: state.defaultOwnerId,
  };
}

// The server refused because someone owns content. When its list can't be read, everyone being
// removed gets the new owner, which moves whatever they own and nothing for the rest.
function refusedOwners(state: OpenState, owners: unknown[]): OwnedMemberContent[] {
  const named = owners.filter(isOwnerEntry);
  if (named.length > 0) return named;
  return state.subjects.map((subject) => ({
    user_id: subject.user_id,
    owned_notes: 0,
    owned_spaces: 0,
  }));
}

export function memberRemovalReducer(
  state: MemberRemovalState,
  event: MemberRemovalEvent
): MemberRemovalState {
  switch (event.type) {
    case "open":
      // A running request can't be taken back, so another selection can't replace it.
      if (state.kind === "running") return state;
      return {
        kind: "checking",
        subjects: event.subjects,
        owners: [],
        transferTo: null,
        defaultOwnerId: event.defaultOwnerId,
      };
    case "previewed":
      if (state.kind !== "checking") return state;
      // A list that can't be read says nothing about owners, as a failed preview doesn't.
      if (!Array.isArray(event.owners)) return confirmWith(state, []);
      return confirmWith(state, event.owners.filter(isOwnerEntry).filter(ownsContent));
    case "previewFailed":
      // The removal itself tells the dialog when someone owns content (transfer_required).
      return state.kind === "checking" ? confirmWith(state, []) : state;
    case "pickOwner":
      if (state.kind !== "confirm" && state.kind !== "failed") return state;
      return { ...state, transferTo: event.userId };
    case "confirm":
      if (state.kind !== "confirm" && state.kind !== "failed") return state;
      return {
        kind: "running",
        subjects: state.subjects,
        owners: state.owners,
        transferTo: state.transferTo,
        defaultOwnerId: state.defaultOwnerId,
      };
    case "failed": {
      if (state.kind !== "running") return state;
      const { error } = event;
      if (error.kind === "transferRequired") {
        return confirmWith(state, refusedOwners(state, error.owners));
      }
      // The new owner left or lost access meanwhile; you can always take the content.
      if (error.kind === "invalidTransferTarget") {
        return { ...state, kind: "failed", transferTo: state.defaultOwnerId, error };
      }
      return { ...state, kind: "failed", error };
    }
    case "succeeded":
      return state.kind === "running" ? { kind: "closed" } : state;
    case "dismiss":
      return state.kind === "running" || state.kind === "closed" ? state : { kind: "closed" };
  }
}

/** Whether the removal moves content to a new owner. */
export function needsTransfer(state: MemberRemovalState): boolean {
  return state.kind !== "closed" && state.owners.length > 0;
}

/** Everyone who can take the content: the roster minus the people being removed, you first. */
export function ownerCandidates(
  roster: WorkspaceMember[],
  state: MemberRemovalState
): WorkspaceMember[] {
  if (state.kind === "closed") return [];
  const removing = new Set(state.subjects.map((subject) => subject.user_id));
  const isDefault = (member: WorkspaceMember): number =>
    member.user_id === state.defaultOwnerId ? 0 : 1;
  return roster
    .filter((member) => !removing.has(member.user_id))
    .sort((a, b) => isDefault(a) - isDefault(b) || memberName(a).localeCompare(memberName(b)));
}
