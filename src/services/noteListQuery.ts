interface NoteListQuery {
  limit?: number;
  before?: string;
  since?: string;
  scope?: "all";
  cursorId?: string;
}

export function buildNotesListPath({
  limit,
  before,
  since,
  scope,
  cursorId,
}: NoteListQuery): string {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  if (since !== undefined) params.set("since", since);
  if (scope !== undefined) params.set("scope", scope);
  // Timestamps are not unique (legacy SQLite rows have second precision),
  // so every paginated request carries the last row id as a tie-breaker.
  if (cursorId !== undefined) {
    if (before !== undefined) params.set("before_id", cursorId);
    else if (since !== undefined) params.set("since_id", cursorId);
  }
  const query = params.toString();
  return `/api/notes/list${query ? `?${query}` : ""}`;
}
