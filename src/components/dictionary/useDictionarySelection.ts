import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { DictionaryRow } from "./dictionaryViewModel";

export interface SelectionState {
  selected: ReadonlySet<string>;
  // The last key ticked on its own; Shift-click selects from here.
  anchor: string | null;
}

export type SelectionAction =
  | { type: "toggle"; key: string }
  | { type: "range"; key: string; orderedKeys: string[] }
  // Adds every listed key; keys a search hides stay selected.
  | { type: "selectAll"; orderedKeys: string[] }
  // Drops keys of rows that left the list, so a row that comes back isn't still ticked.
  | { type: "retain"; orderedKeys: string[] }
  | { type: "clear" };

const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "toggle": {
      const selected = new Set(state.selected);
      if (selected.has(action.key)) selected.delete(action.key);
      else selected.add(action.key);
      return { selected, anchor: action.key };
    }
    case "range": {
      const end = action.orderedKeys.indexOf(action.key);
      if (end === -1) return state;
      const start = state.anchor === null ? -1 : action.orderedKeys.indexOf(state.anchor);
      const selected = new Set(state.selected);
      // With no anchor in the list there is no range yet: the click starts one.
      if (start === -1) {
        selected.add(action.key);
        return { selected, anchor: action.key };
      }
      const [from, to] = start <= end ? [start, end] : [end, start];
      for (const key of action.orderedKeys.slice(from, to + 1)) selected.add(key);
      return { selected, anchor: state.anchor };
    }
    case "selectAll":
      return {
        selected: new Set([...state.selected, ...action.orderedKeys]),
        anchor: state.anchor,
      };
    case "retain": {
      const keep = new Set(action.orderedKeys);
      const selected = new Set([...state.selected].filter((key) => keep.has(key)));
      const anchor = state.anchor !== null && keep.has(state.anchor) ? state.anchor : null;
      if (selected.size === state.selected.size && anchor === state.anchor) return state;
      return { selected, anchor };
    }
    case "clear":
      return state.selected.size === 0 && state.anchor === null ? state : EMPTY_SELECTION;
  }
}

export interface DictionarySelection {
  // Selected rows in list order, including those the search hides.
  selectedRows: DictionaryRow[];
  // Whether every row the search shows is selected.
  allShownSelected: boolean;
  isSelected: (key: string) => boolean;
  toggle: (key: string, extend: boolean) => void;
  selectAll: () => void;
  clear: () => void;
}

/**
 * `rows` are the rows shown (ranges and select-all work on them); `listRows`
 * are all the open list's rows. Only a row that leaves the list is unselected,
 * so a search narrowing what's shown keeps the rest of the selection.
 */
export function useDictionarySelection(
  rows: DictionaryRow[],
  listRows: DictionaryRow[]
): DictionarySelection {
  const [state, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);
  const orderedKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const listKeys = useMemo(() => listRows.map((row) => row.key), [listRows]);
  useEffect(() => dispatch({ type: "retain", orderedKeys: listKeys }), [listKeys]);
  // Filtered as well, for the render before the prune lands.
  const selectedRows = useMemo(
    () => listRows.filter((row) => state.selected.has(row.key)),
    [listRows, state.selected]
  );
  const visible = useMemo(() => new Set(selectedRows.map((row) => row.key)), [selectedRows]);
  const allShownSelected = useMemo(
    () => rows.length > 0 && rows.every((row) => visible.has(row.key)),
    [rows, visible]
  );

  const toggle = useCallback(
    (key: string, extend: boolean): void =>
      dispatch(extend ? { type: "range", key, orderedKeys } : { type: "toggle", key }),
    [orderedKeys]
  );
  const selectAll = useCallback(
    (): void => dispatch({ type: "selectAll", orderedKeys }),
    [orderedKeys]
  );
  const clear = useCallback((): void => dispatch({ type: "clear" }), []);
  const isSelected = useCallback((key: string): boolean => visible.has(key), [visible]);

  return { selectedRows, allShownSelected, isSelected, toggle, selectAll, clear };
}
