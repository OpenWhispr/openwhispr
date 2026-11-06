import { useCallback, useEffect, useRef, useState } from "react";
import { GuestsService } from "../services/GuestsService";
import { classifyRowActionError, type RowActionError } from "../lib/workspaceErrors";
import type { WorkspaceGuest } from "../types/electron";

export interface WorkspaceGuestsState {
  status: "loading" | "ready" | "failed";
  guests: WorkspaceGuest[];
  error: RowActionError | null;
  reload: () => Promise<void>;
  /** Takes whole guests out of the shown list at once, e.g. after a removal, ahead of a reload. */
  dropGuests: (emails: string[]) => void;
}

// What the last answer for one workspace left behind; an answer is only ever kept under the
// workspace id it was asked for.
interface Slot {
  workspaceId: string;
  guests: WorkspaceGuest[] | null;
  error: RowActionError | null;
}

const NO_GUESTS: WorkspaceGuest[] = [];

/**
 * The live guest list for one workspace. Guests have no local mirror, so the tab reads the
 * server when it mounts and again after each action; there is no polling.
 */
export function useWorkspaceGuests(workspaceId: string): WorkspaceGuestsState {
  const [slot, setSlot] = useState<Slot | null>(null);
  const currentWorkspaceRef = useRef(workspaceId);
  const latestRequestRef = useRef(0);

  // Declared before the load effect so a workspace switch updates the ref before that load starts.
  useEffect(() => {
    currentWorkspaceRef.current = workspaceId;
    return () => {
      currentWorkspaceRef.current = "";
    };
  }, [workspaceId]);

  const load = useCallback(async (target: string): Promise<void> => {
    if (currentWorkspaceRef.current !== target) return;
    const requestId = ++latestRequestRef.current;
    let guests: WorkspaceGuest[] | null = null;
    let error: RowActionError | null = null;
    try {
      guests = await GuestsService.list(target);
    } catch (caught) {
      error = classifyRowActionError(caught);
    }
    // A switch, an unmount or a newer request makes this answer stale.
    if (currentWorkspaceRef.current !== target || latestRequestRef.current !== requestId) return;
    // A reload that fails behind a list already on screen keeps that list; only a load with
    // nothing to show falls back to Failed.
    setSlot((previous) =>
      !guests && previous && previous.workspaceId === target && previous.guests
        ? { ...previous, error }
        : { workspaceId: target, guests, error }
    );
  }, []);

  useEffect(() => {
    void load(workspaceId);
  }, [workspaceId, load]);

  const reload = useCallback((): Promise<void> => load(workspaceId), [load, workspaceId]);

  const dropGuests = useCallback(
    (emails: string[]): void => {
      const gone = new Set(emails.map((email) => email.toLowerCase()));
      setSlot((previous) =>
        previous && previous.workspaceId === workspaceId && previous.guests
          ? {
              ...previous,
              guests: previous.guests.filter((guest) => !gone.has(guest.email.toLowerCase())),
            }
          : previous
      );
    },
    [workspaceId]
  );

  const own = slot && slot.workspaceId === workspaceId ? slot : null;
  if (!own) return { status: "loading", guests: NO_GUESTS, error: null, reload, dropGuests };
  if (own.guests)
    return { status: "ready", guests: own.guests, error: own.error, reload, dropGuests };
  return { status: "failed", guests: NO_GUESTS, error: own.error, reload, dropGuests };
}
