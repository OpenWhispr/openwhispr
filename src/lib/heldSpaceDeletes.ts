// Teamspaces whose delete is waiting out its Undo window. Nothing has happened to them yet, here or
// on the server, so the views that list them only need to leave them out.
type Listener = () => void;

let heldCloudIds: ReadonlySet<string> = new Set();
let heldLocalIds: ReadonlySet<number> = new Set();
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function holdSpace(localId: number, cloudId: string): void {
  heldLocalIds = new Set(heldLocalIds).add(localId);
  heldCloudIds = new Set(heldCloudIds).add(cloudId);
  publish();
}

export function releaseSpace(localId: number, cloudId: string): void {
  const nextLocal = new Set(heldLocalIds);
  const nextCloud = new Set(heldCloudIds);
  nextLocal.delete(localId);
  nextCloud.delete(cloudId);
  heldLocalIds = nextLocal;
  heldCloudIds = nextCloud;
  publish();
}

/**
 * The delete went through. The space stays out of the lists: a directory read from before the
 * delete still names it, and nothing else reads that list again.
 */
export function markHeldSpaceDeleted(localId: number): void {
  const nextLocal = new Set(heldLocalIds);
  nextLocal.delete(localId);
  heldLocalIds = nextLocal;
  publish();
}

/** Another account is signing in, and nothing held belongs to it. */
export function forgetHeldSpaces(): void {
  heldLocalIds = new Set();
  heldCloudIds = new Set();
  publish();
}

export function isSpaceHeld(localId: number): boolean {
  return heldLocalIds.has(localId);
}

export function heldCloudSpaceIds(): ReadonlySet<string> {
  return heldCloudIds;
}

export function subscribeHeldSpaces(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
