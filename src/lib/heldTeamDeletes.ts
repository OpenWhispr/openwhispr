// Teams whose delete is waiting out its Undo window. Nothing has happened to them yet, here or on
// the server, so the views that list them only need to leave them out.
type Listener = () => void;

let heldIds: ReadonlySet<string> = new Set();
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener();
}

// A team whose delete went through is deliberately never released: it stays in the set so a
// directory read from before the delete can't bring it back. Only an account change clears it.
export function holdTeam(teamId: string): void {
  heldIds = new Set(heldIds).add(teamId);
  publish();
}

export function releaseTeam(teamId: string): void {
  const next = new Set(heldIds);
  next.delete(teamId);
  heldIds = next;
  publish();
}

/** Another account is signing in, and nothing held belongs to it. */
export function forgetHeldTeams(): void {
  heldIds = new Set();
  publish();
}

export function isTeamHeld(teamId: string): boolean {
  return heldIds.has(teamId);
}

export function heldTeamIds(): ReadonlySet<string> {
  return heldIds;
}

export function subscribeHeldTeams(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
