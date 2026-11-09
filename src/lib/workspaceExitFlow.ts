// Pure state machine for the leave and delete workspace dialogs. Every state
// carries the workspace name taken at start, so an outcome dialog keeps naming
// the workspace that was left or deleted even after the store moves on.
export type ExitState =
  | { kind: "closed" }
  | { kind: "confirmLeave" | "leaving" | "left"; name: string }
  | { kind: "confirmDelete" | "deleting" | "deleted"; name: string }
  // `reason` is the server's refusal, null when the request may not have reached it.
  | { kind: "leaveFailed" | "deleteFailed"; name: string; reason: string | null };

export type ExitEvent =
  | { type: "startLeave" | "startDelete"; name: string }
  | { type: "confirm" }
  | { type: "succeeded" }
  | { type: "failed"; reason: string | null }
  | { type: "dismiss" };

export function exitReducer(state: ExitState, event: ExitEvent): ExitState {
  switch (event.type) {
    case "startLeave":
      return { kind: "confirmLeave", name: event.name };
    case "startDelete":
      return { kind: "confirmDelete", name: event.name };
    case "confirm":
      if (state.kind === "confirmLeave" || state.kind === "leaveFailed") {
        return { kind: "leaving", name: state.name };
      }
      if (state.kind === "confirmDelete" || state.kind === "deleteFailed") {
        return { kind: "deleting", name: state.name };
      }
      return state;
    case "succeeded":
      if (state.kind === "leaving") return { kind: "left", name: state.name };
      if (state.kind === "deleting") return { kind: "deleted", name: state.name };
      return state;
    case "failed":
      if (state.kind === "leaving") {
        return { kind: "leaveFailed", name: state.name, reason: event.reason };
      }
      if (state.kind === "deleting") {
        return { kind: "deleteFailed", name: state.name, reason: event.reason };
      }
      return state;
    case "dismiss":
      // A running leave or delete can't be taken back, so it can't be closed.
      if (state.kind === "leaving" || state.kind === "deleting" || state.kind === "closed") {
        return state;
      }
      return { kind: "closed" };
  }
}
