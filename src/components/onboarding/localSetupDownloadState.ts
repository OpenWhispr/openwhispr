// The download queue behind "We recommend these settings": one item at a time,
// dictation, then cleanup, then the assistant (a row's graphics pack follows its
// model). A failed row doesn't stop the rows after it, and Retry puts it back in
// line after the one downloading. A failed graphics pack doesn't fail its row:
// the model runs on the processor without it, and Settings can add it later.
// Pure, so useLocalSetupDownloads only runs the item this state names.
import type { LocalSetupDownload, LocalSetupRowId } from "../../config/localSetup";

export type RowStatus = "waiting" | "downloading" | "installing" | "done" | "failed";

export interface LocalSetupItemState extends LocalSetupDownload {
  status: RowStatus;
  percent: number;
}

export interface LocalSetupRowState {
  rowId: LocalSetupRowId;
  items: LocalSetupItemState[];
}

export interface LocalSetupDownloadState {
  rows: LocalSetupRowState[];
  /** Item keys the inventory found on disk; kept so a reconfigure doesn't lose them. */
  onDisk: string[];
  started: boolean;
  /** Rows still to run, the active one first. */
  queue: LocalSetupRowId[];
  /** `run` numbers each activation, so a late result for an earlier item is ignored. */
  active: { rowId: LocalSetupRowId; item: number; run: number } | null;
  run: number;
}

export type LocalSetupDownloadEvent =
  | { type: "configure"; rows: Array<{ rowId: LocalSetupRowId; items: LocalSetupDownload[] }> }
  | { type: "inventory"; onDisk: string[] }
  | { type: "start" }
  | { type: "progress"; run: number; percent: number }
  | { type: "installing"; run: number }
  | { type: "complete"; run: number }
  | { type: "fail"; run: number }
  | { type: "retry"; rowId: LocalSetupRowId };

export function localSetupItemKey(item: Pick<LocalSetupDownload, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

/** A graphics pack that failed: its row goes on without it. */
function isDroppedPack(item: LocalSetupItemState): boolean {
  return item.kind === "llamaVulkan" && item.status === "failed";
}

/** A failure that fails its row: any but the graphics pack's. */
function blocksRow(item: LocalSetupItemState): boolean {
  return item.status === "failed" && !isDroppedPack(item);
}

/** Nothing left that the row waits on. */
function isSettled(item: LocalSetupItemState): boolean {
  return item.status === "done" || isDroppedPack(item);
}

function markOnDisk(rows: LocalSetupRowState[], onDisk: string[]): LocalSetupRowState[] {
  if (!onDisk.length) return rows;
  return rows.map((row) => ({
    ...row,
    items: row.items.map((item) =>
      item.status === "waiting" && onDisk.includes(localSetupItemKey(item))
        ? { ...item, status: "done" as const, percent: 100 }
        : item
    ),
  }));
}

export function createLocalSetupDownloadState(
  rows: Array<{ rowId: LocalSetupRowId; items: LocalSetupDownload[] }>,
  onDisk: string[] = []
): LocalSetupDownloadState {
  return {
    rows: markOnDisk(
      rows.map(({ rowId, items }) => ({
        rowId,
        items: items.map((item) => ({ ...item, status: "waiting" as const, percent: 0 })),
      })),
      onDisk
    ),
    onDisk,
    started: false,
    queue: [],
    active: null,
    run: 0,
  };
}

function updateItem(
  state: LocalSetupDownloadState,
  rowId: LocalSetupRowId,
  index: number,
  patch: Partial<LocalSetupItemState>
): LocalSetupDownloadState {
  return {
    ...state,
    rows: state.rows.map((row) =>
      row.rowId !== rowId
        ? row
        : {
            ...row,
            items: row.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
          }
    ),
  };
}

/** Moves to the next waiting item: the rest of the head row, then the rows behind it. */
function activateNext(state: LocalSetupDownloadState): LocalSetupDownloadState {
  const queue = [...state.queue];
  while (queue.length) {
    const row = state.rows.find((r) => r.rowId === queue[0]);
    const index = row?.items.findIndex((item) => item.status === "waiting") ?? -1;
    if (row && index >= 0 && !row.items.some(blocksRow)) {
      const run = state.run + 1;
      return {
        ...updateItem(state, row.rowId, index, { status: "downloading", percent: 0 }),
        queue,
        active: { rowId: row.rowId, item: index, run },
        run,
      };
    }
    queue.shift();
  }
  return { ...state, queue, active: null };
}

export function reduce(
  state: LocalSetupDownloadState,
  event: LocalSetupDownloadEvent
): LocalSetupDownloadState {
  switch (event.type) {
    case "configure":
      // Switches lock once downloading starts.
      return state.started ? state : createLocalSetupDownloadState(event.rows, state.onDisk);
    case "inventory": {
      const onDisk = [...new Set([...state.onDisk, ...event.onDisk])];
      return { ...state, onDisk, rows: markOnDisk(state.rows, onDisk) };
    }
    case "start":
      if (state.started) return state;
      return activateNext({ ...state, started: true, queue: state.rows.map((r) => r.rowId) });
    case "progress":
    case "installing": {
      const { active } = state;
      if (!active || active.run !== event.run) return state;
      const item = state.rows.find((r) => r.rowId === active.rowId)?.items[active.item];
      if (!item || item.status === "installing") return state;
      return updateItem(
        state,
        active.rowId,
        active.item,
        event.type === "installing"
          ? { status: "installing", percent: 100 }
          : { status: "downloading", percent: Math.max(0, Math.min(100, event.percent)) }
      );
    }
    case "complete":
    case "fail": {
      const { active } = state;
      if (!active || active.run !== event.run) return state;
      const patch: Partial<LocalSetupItemState> =
        event.type === "complete" ? { status: "done", percent: 100 } : { status: "failed" };
      return activateNext(updateItem(state, active.rowId, active.item, patch));
    }
    case "retry": {
      const row = state.rows.find((r) => r.rowId === event.rowId);
      if (!state.started || !row?.items.some(blocksRow)) return state;
      const reset: LocalSetupDownloadState = {
        ...state,
        rows: state.rows.map((r) =>
          r !== row
            ? r
            : {
                ...r,
                items: r.items.map((item) =>
                  blocksRow(item) ? { ...item, status: "waiting", percent: 0 } : item
                ),
              }
        ),
      };
      if (!state.active) return activateNext({ ...reset, queue: [event.rowId] });
      const queue = state.queue.filter((id) => id !== event.rowId);
      queue.splice(1, 0, event.rowId);
      return { ...reset, queue };
    }
  }
}

export function activeItem(state: LocalSetupDownloadState): LocalSetupItemState | null {
  const { active } = state;
  if (!active) return null;
  return state.rows.find((r) => r.rowId === active.rowId)?.items[active.item] ?? null;
}

export function rowStatus(state: LocalSetupDownloadState, rowId: LocalSetupRowId): RowStatus {
  const row = state.rows.find((r) => r.rowId === rowId);
  if (!row) return "waiting";
  if (row.items.some(blocksRow)) return "failed";
  if (row.items.every(isSettled)) return "done";
  if (state.active?.rowId === rowId) return row.items[state.active.item].status;
  return "waiting";
}

/**
 * The row's pie, 0–100: its items weighted by size. Full only once every item is.
 * A graphics pack that failed drops out, so the row's pie fills with its model.
 */
export function rowPercent(state: LocalSetupDownloadState, rowId: LocalSetupRowId): number {
  const row = state.rows.find((r) => r.rowId === rowId);
  if (!row) return 0;
  const counted = row.items.filter((item) => !isDroppedPack(item));
  const total = counted.reduce((sum, item) => sum + item.bytes, 0);
  if (total <= 0) return row.items.every(isSettled) ? 100 : 0;
  const done = counted.reduce((sum, item) => sum + (item.bytes * item.percent) / 100, 0);
  return Math.floor((done / total) * 100);
}

export function allEnabledDone(state: LocalSetupDownloadState): boolean {
  return state.rows.every((row) => row.items.every(isSettled));
}
