import { useSyncExternalStore } from "react";
import { getListsOwnerRevision, subscribeListsOwner } from "../stores/settingsStore";

/** Changes whenever the personal dictionary and snippets start belonging to another account. */
export function useListsOwnerRevision(): number {
  return useSyncExternalStore(subscribeListsOwner, getListsOwnerRevision);
}
