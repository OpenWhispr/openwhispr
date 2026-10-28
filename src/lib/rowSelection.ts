// Selections are never mutated, so React sees every change as a new value.
export type RowSelection = ReadonlySet<string>;

export function toggleRow(selection: RowSelection, id: string): RowSelection {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function setRows(
  selection: RowSelection,
  ids: readonly string[],
  selected: boolean
): RowSelection {
  const next = new Set(selection);
  for (const id of ids) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Returns `selection` itself when nothing is dropped, so effects keyed on it don't loop. */
export function keepRows(selection: RowSelection, ids: Iterable<string>): RowSelection {
  const kept = new Set<string>();
  for (const id of ids) {
    if (selection.has(id)) kept.add(id);
  }
  return kept.size === selection.size ? selection : kept;
}

export function headerCheckState(
  visibleIds: readonly string[],
  selection: RowSelection
): "none" | "some" | "all" {
  const selected = visibleIds.filter((id) => selection.has(id)).length;
  if (selected === 0) return "none";
  return selected === visibleIds.length ? "all" : "some";
}
