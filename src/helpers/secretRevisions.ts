import { envRefName } from "./envRef";

// A reference keeps its spelling when the secret it points to changes in main.
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

export function subscribeSecretRevisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function referenceRevision(value: unknown): number {
  const name = envRefName(value);
  return name ? (revisions.get(name) ?? 0) : 0;
}

export function notifySecretChanges(...names: string[]): void {
  for (const name of names) revisions.set(name, (revisions.get(name) ?? 0) + 1);
  for (const listener of listeners) listener();
}
