import type { RowActionError } from "./workspaceErrors";

// Pure state machine for a confirm → running → failed dialog over one subject (a member, an
// invitation). A success is not an event: the caller dispatches `dismiss` once the action
// resolves, so the dialog has nothing to show for it.
export type ConfirmActionState<S> =
  | { kind: "closed" }
  | { kind: "confirm" | "running"; subject: S }
  | { kind: "failed"; subject: S; error: RowActionError };

export type ConfirmActionEvent<S> =
  | { type: "open"; subject: S }
  | { type: "confirm" }
  | { type: "failed"; error: RowActionError }
  | { type: "dismiss" };

export function confirmActionReducer<S>(
  state: ConfirmActionState<S>,
  event: ConfirmActionEvent<S>
): ConfirmActionState<S> {
  switch (event.type) {
    case "open":
      // A running request can't be taken back, so another row can't replace it.
      return state.kind === "running" ? state : { kind: "confirm", subject: event.subject };
    case "confirm":
      if (state.kind === "confirm" || state.kind === "failed") {
        return { kind: "running", subject: state.subject };
      }
      return state;
    case "failed":
      return state.kind === "running"
        ? { kind: "failed", subject: state.subject, error: event.error }
        : state;
    case "dismiss":
      return state.kind === "running" || state.kind === "closed" ? state : { kind: "closed" };
  }
}
