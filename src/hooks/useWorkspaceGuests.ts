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
  /** Takes one note off a guest at once; a guest left with no notes leaves the list. */
  dropGuestNote: (email: string, noteId: string) => void;
}

// What the last answer left behind.
interface Slot {
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
  const latestRequestRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const requestId = ++latestRequestRef.current;
    let guests: WorkspaceGuest[] | null = null;
    let error: RowActionError | null = null;
    try {
      guests = await GuestsService.list(workspaceId);
    } catch (caught) {
      error = classifyRowActionError(caught);
    }
    // A newer request makes this answer stale.
    if (latestRequestRef.current !== requestId) return;
    // A reload that fails behind a list already on screen keeps that list; only a load with
    // nothing to show falls back to Failed.
    setSlot((previous) => (!guests && previous?.guests ? previous : { guests, error }));
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dropGuests = useCallback((emails: string[]): void => {
    const gone = new Set(emails.map((email) => email.toLowerCase()));
    setSlot((previous) =>
      previous?.guests
        ? {
            ...previous,
            guests: previous.guests.filter((guest) => !gone.has(guest.email.toLowerCase())),
          }
        : previous
    );
  }, []);

  const dropGuestNote = useCallback((email: string, noteId: string): void => {
    const target = email.toLowerCase();
    setSlot((previous) =>
      previous?.guests
        ? {
            ...previous,
            guests: previous.guests
              .map((guest) =>
                guest.email.toLowerCase() === target
                  ? { ...guest, notes: guest.notes.filter((note) => note.id !== noteId) }
                  : guest
              )
              .filter((guest) => guest.email.toLowerCase() !== target || guest.notes.length > 0),
          }
        : previous
    );
  }, []);

  if (!slot)
    return { status: "loading", guests: NO_GUESTS, error: null, reload, dropGuests, dropGuestNote };
  if (slot.guests)
    return {
      status: "ready",
      guests: slot.guests,
      error: slot.error,
      reload,
      dropGuests,
      dropGuestNote,
    };
  return {
    status: "failed",
    guests: NO_GUESTS,
    error: slot.error,
    reload,
    dropGuests,
    dropGuestNote,
  };
}
