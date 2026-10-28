import type { RowActionError } from "./workspaceErrors";

// Pure state machine for a confirm → running → failed dialog over one subject (a member, an
// invitation). A success has no screen of its own: the caller dispatches `succeeded` once the
// action resolves and the dialog closes. `dismiss` is the user's way out and is ignored while
// the request runs, so it can't report a success.
export type ConfirmActionState<S> =
  | { kind: "closed" }
  | { kind: "confirm" | "running"; subject: S }
  | { kind: "failed"; subject: S; error: RowActionError };

export type ConfirmActionEvent<S> =
  | { type: "open"; subject: S }
  | { type: "confirm" }
  | { type: "failed"; error: RowActionError }
  | { type: "succeeded" }
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
    case "succeeded":
      return state.kind === "running" ? { kind: "closed" } : state;
    case "dismiss":
      return state.kind === "running" || state.kind === "closed" ? state : { kind: "closed" };
  }
}
