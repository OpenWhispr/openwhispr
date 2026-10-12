/**
 * Small trailing note near the sync status (see SyncStatusLabel) — the only surface that
 * currently exists for conflict visibility, alongside the Keep-mine/Use-server banner on the
 * note editor (see ConflictBanner). Returns null when there's nothing to flag.
 */
export function describeConflictCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? 'note needs' : 'notes need'} review`;
}
