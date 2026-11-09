import type { WorkspaceGuest } from "../types/electron";

export function guestDisplayName(guest: WorkspaceGuest): string {
  const name = guest.name?.trim();
  return name ? name : guest.email;
}

// A removal can't close a note shared by link or domain, so the confirm has to say so.
export function hasLinkSharedNote(guests: WorkspaceGuest[]): boolean {
  return guests.some((guest) =>
    guest.notes.some((note) => note.visibility === "link" || note.visibility === "domain")
  );
}
