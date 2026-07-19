// Reactive view over the localStorage team-spaces capability flag: the sync
// pass probes the server and writes the flag, and mounted consumers
// (useTeamSpacesCapability) must re-render when it flips — same-window flips
// notify subscribers directly, cross-window ones ride the storage event.
const CAPABILITY_KEY = "teamSpacesCapability";

const subscribers = new Set<() => void>();

export function readTeamSpacesCapability(): boolean {
  return localStorage.getItem(CAPABILITY_KEY) === "true";
}

export function notifyTeamSpacesCapabilityChanged(): void {
  subscribers.forEach((notify) => notify());
}

export function subscribeTeamSpacesCapability(onChange: () => void): () => void {
  subscribers.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === CAPABILITY_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    subscribers.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
