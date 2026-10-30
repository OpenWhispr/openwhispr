import { useEffect, useState } from "react";

export interface InvitationNotesEntry {
  workspaceId: string;
  teamIds: string[];
  spaceIds: string[];
}

// An accepted invitation's entry covers only the visit to Notes that follows it.
// Leaving Notes ends it: otherwise an invitation whose space never syncs here
// (a workspace with no team space yet) replays the structure intro on every
// later visit, and a space that syncs in much later pulls the user away from
// whatever they opened since.
export function useInvitationNotesEntry(
  isNotesActive: boolean
): [InvitationNotesEntry | null, (entry: InvitationNotesEntry | null) => void] {
  const [entry, setEntry] = useState<InvitationNotesEntry | null>(null);

  useEffect(() => {
    if (!isNotesActive) setEntry(null);
  }, [isNotesActive]);

  return [entry, setEntry];
}
