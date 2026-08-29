const rosterCache = new Map<string, Promise<unknown>>();
const rosterVersions = new Map<string, number>();
const rosterListeners = new Map<string, Set<() => void>>();

export function fetchCachedSpaceRoster<T>(
  cloudSpaceId: string,
  loader: () => Promise<T>
): Promise<T> {
  let roster = rosterCache.get(cloudSpaceId) as Promise<T> | undefined;
  if (!roster) {
    roster = loader();
    roster.catch(() => {
      if (rosterCache.get(cloudSpaceId) === roster) rosterCache.delete(cloudSpaceId);
    });
    rosterCache.set(cloudSpaceId, roster);
  }
  return roster;
}

export function subscribeSpaceRoster(cloudSpaceId: string, listener: () => void): () => void {
  const listeners = rosterListeners.get(cloudSpaceId) ?? new Set<() => void>();
  listeners.add(listener);
  rosterListeners.set(cloudSpaceId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) rosterListeners.delete(cloudSpaceId);
  };
}

export function readSpaceRosterVersion(cloudSpaceId: string | null): number {
  return cloudSpaceId ? (rosterVersions.get(cloudSpaceId) ?? 0) : 0;
}

export function invalidateSpaceRoster(cloudSpaceId?: string): void {
  const ids = cloudSpaceId
    ? [cloudSpaceId]
    : [...new Set([...rosterCache.keys(), ...rosterListeners.keys()])];
  for (const id of ids) {
    rosterCache.delete(id);
    rosterVersions.set(id, (rosterVersions.get(id) ?? 0) + 1);
    for (const listener of [...(rosterListeners.get(id) ?? [])]) listener();
  }
}
