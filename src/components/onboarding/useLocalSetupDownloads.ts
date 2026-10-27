// Runs the "We recommend these settings" downloads one at a time through the
// app's existing download machinery: useModelDownload for the models (errors
// shown on the row, not in a dialog) and the llama-vulkan IPC for the graphics
// pack (a failure is only logged: nothing on screen names the pack, and its row
// goes on without it). localSetupDownloadState decides what runs next; this hook
// only starts the item it names and reports back. Unmounting (Back) cancels the
// item in flight and starts nothing else; models that already finished stay on disk.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  enabledDownloads,
  type LocalSetupDownload,
  type LocalSetupPlan,
  type LocalSetupRowId,
  type LocalSetupSwitches,
} from "../../config/localSetup";
import { useModelDownload } from "../../hooks/useModelDownload";
import logger from "../../utils/logger";
import {
  activeItem,
  allEnabledDone,
  createLocalSetupDownloadState,
  localSetupItemKey,
  reduce,
  rowPercent,
  rowStatus,
  type RowStatus,
} from "./localSetupDownloadState";
import { claimLocalSetupDownload, releaseLocalSetupDownload } from "./localSetupDownloadClaims";

export interface LocalSetupRowProgress {
  status: RowStatus;
  percent: number;
}

const ROW_IDS: LocalSetupRowId[] = ["dictation", "cleanup", "assistant"];

type ModelDownloader = Pick<
  ReturnType<typeof useModelDownload>,
  "downloadModel" | "cancelDownload" | "downloads"
>;
type Downloaders = Record<Exclude<LocalSetupDownload["kind"], "llamaVulkan">, ModelDownloader>;

/** Keys (localSetupItemKey) of every model, and the graphics pack, already on disk. */
export async function readLocalSetupInventory(
  api: Window["electronAPI"] | undefined,
  packId: string | undefined
): Promise<string[]> {
  const [whisper, parakeet, llm, pack] = await Promise.all([
    api?.listWhisperModels?.().catch(() => undefined),
    api?.listParakeetModels?.().catch(() => undefined),
    api?.modelGetAll?.().catch(() => undefined),
    packId ? api?.getLlamaVulkanStatus?.().catch(() => undefined) : undefined,
  ]);
  const keys: string[] = [];
  for (const model of whisper?.models ?? []) {
    if (model.downloaded) keys.push(localSetupItemKey({ kind: "whisper", id: model.model }));
  }
  for (const model of parakeet?.models ?? []) {
    if (model.downloaded) keys.push(localSetupItemKey({ kind: "parakeet", id: model.model }));
  }
  for (const model of llm ?? []) {
    if (model.isDownloaded) keys.push(localSetupItemKey({ kind: "llm", id: model.id }));
  }
  if (packId && pack?.downloaded) {
    keys.push(localSetupItemKey({ kind: "llamaVulkan", id: packId }));
  }
  return keys;
}

async function downloadItem(item: LocalSetupDownload, downloaders: Downloaders): Promise<boolean> {
  if (item.kind === "llamaVulkan") {
    const result = await window.electronAPI?.downloadLlamaVulkanBinary?.();
    if (result?.success === true) return true;
    if (!result?.cancelled) {
      logger.warn(
        "Graphics pack download failed; text models run on the processor",
        { error: result?.error ?? "no result" },
        "onboarding"
      );
    }
    return false;
  }
  return downloaders[item.kind].downloadModel(item.id);
}

export function useLocalSetupDownloads(
  plan: LocalSetupPlan,
  switches: LocalSetupSwitches
): {
  rows: Record<LocalSetupRowId, LocalSetupRowProgress>;
  started: boolean;
  allDone: boolean;
  /** Keys (localSetupItemKey) of every item the inventory found on disk. */
  onDisk: string[];
  start: () => void;
  retry: (rowId: LocalSetupRowId) => void;
} {
  const whisper = useModelDownload({ modelType: "whisper", showErrorDialog: false });
  const parakeet = useModelDownload({ modelType: "parakeet", showErrorDialog: false });
  const llm = useModelDownload({ modelType: "llm", showErrorDialog: false });
  const downloadersRef = useRef<Downloaders>({ whisper, parakeet, llm });
  useEffect(() => {
    downloadersRef.current = { whisper, parakeet, llm };
  });

  const { cleanup, assistant } = switches;
  const queueRows = useMemo(
    () => enabledDownloads(plan, { cleanup, assistant }),
    [plan, cleanup, assistant]
  );
  const [state, dispatch] = useReducer(reduce, queueRows, createLocalSetupDownloadState);
  useEffect(() => {
    dispatch({ type: "configure", rows: queueRows });
  }, [queueRows]);

  const packId = plan.graphicsPack?.id;
  useEffect(() => {
    let disposed = false;
    void readLocalSetupInventory(window.electronAPI, packId).then((onDisk) => {
      if (!disposed) dispatch({ type: "inventory", onDisk });
    });
    return () => {
      disposed = true;
    };
  }, [packId]);

  // The item in flight. Cleared on unmount, so a result that lands after Back is dropped.
  const runningRef = useRef<{ item: LocalSetupDownload; run: number } | null>(null);
  const cancelledRef = useRef(false);
  // A model request that came back false: the run whose outcome waits on the next
  // render (state, and a ref for unmount), and the run found joined to a transfer
  // of the same model already under way.
  const [unsettledRun, setUnsettledRun] = useState<number | null>(null);
  const unsettledRunRef = useRef<number | null>(null);
  const joinedRunRef = useRef<number | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      // Back: stop the transfer in flight and start nothing else. Its tray claim is
      // released when the transfer settles, not here: a cancel can't stop an
      // archive mid-unpack, and a late error must not open a tray row.
      cancelledRef.current = true;
      const running = runningRef.current;
      runningRef.current = null;
      if (!running) return;
      // A request that already came back has nothing left to settle and release it.
      if (unsettledRunRef.current === running.run) releaseLocalSetupDownload(running.item);
      if (running.item.kind === "llamaVulkan") {
        void window.electronAPI?.cancelLlamaVulkanDownload?.();
      } else {
        void downloadersRef.current[running.item.kind].cancelDownload(running.item.id);
      }
    };
  }, []);

  const run = state.active?.run ?? null;
  const current = activeItem(state);
  useEffect(() => {
    if (run === null || !current || runningRef.current?.run === run) return;
    if (cancelledRef.current) return;
    const item: LocalSetupDownload = { kind: current.kind, id: current.id, bytes: current.bytes };
    runningRef.current = { item, run };
    claimLocalSetupDownload(item);
    void downloadItem(item, downloadersRef.current)
      .catch((error) => {
        logger.warn(
          "Local setup download failed",
          { kind: item.kind, id: item.id, error },
          "onboarding"
        );
        return false;
      })
      .then((ok) => {
        if (cancelledRef.current || runningRef.current?.run !== run) {
          releaseLocalSetupDownload(item);
          return;
        }
        if (ok || item.kind === "llamaVulkan") {
          releaseLocalSetupDownload(item);
          runningRef.current = null;
          dispatch({ type: ok ? "complete" : "fail", run });
          return;
        }
        // Failed, or refused because this model is already downloading: the next
        // render shows which (see the effect below).
        unsettledRunRef.current = run;
        setUnsettledRun(run);
      });
  }, [current, run]);

  // Progress for a model comes from its useModelDownload instance.
  const modelStatus =
    current && current.kind !== "llamaVulkan"
      ? { whisper, parakeet, llm }[current.kind].downloads[current.id]
      : undefined;
  const phase = modelStatus?.phase;
  const progress = modelStatus?.progress ?? 0;
  useEffect(() => {
    if (run === null || !phase) return;
    dispatch(
      phase === "installing"
        ? { type: "installing", run }
        : { type: "progress", run, percent: progress }
    );
  }, [phase, progress, run]);

  // A model request that came back false. If the model is still listed as
  // downloading, the request joined a transfer already under way (an older build's,
  // or one still winding down): its progress shows on the row, and once it ends the
  // row is done only if the model is now on disk. Otherwise the request failed.
  const downloading = !!modelStatus;
  useEffect(() => {
    if (unsettledRun === null || unsettledRun !== run || !current) return;
    if (downloading) {
      joinedRunRef.current = run;
      return;
    }
    const item = runningRef.current?.item;
    const finish = (ok: boolean) => {
      if (cancelledRef.current || runningRef.current?.run !== run) return;
      if (item) releaseLocalSetupDownload(item);
      runningRef.current = null;
      unsettledRunRef.current = null;
      setUnsettledRun(null);
      dispatch({ type: ok ? "complete" : "fail", run });
    };
    if (joinedRunRef.current !== run) {
      finish(false);
      return;
    }
    const key = localSetupItemKey(current);
    void readLocalSetupInventory(window.electronAPI, undefined).then((onDisk) =>
      finish(onDisk.includes(key))
    );
  }, [current, downloading, run, unsettledRun]);

  // The graphics pack reports through its own channel.
  useEffect(() => {
    const dispose = window.electronAPI?.onLlamaVulkanDownloadProgress?.((data) => {
      const running = runningRef.current;
      if (running?.item.kind !== "llamaVulkan") return;
      dispatch({ type: "progress", run: running.run, percent: data.percentage });
    });
    return () => dispose?.();
  }, []);

  const rows = useMemo(() => {
    const out = {} as Record<LocalSetupRowId, LocalSetupRowProgress>;
    for (const rowId of ROW_IDS) {
      if (state.rows.some((row) => row.rowId === rowId)) {
        out[rowId] = { status: rowStatus(state, rowId), percent: rowPercent(state, rowId) };
        continue;
      }
      // Switched off, unavailable or hidden: never queued, but its model may be on disk.
      const planRow = plan.rows.find((row) => row.id === rowId);
      const onDisk = !!planRow && state.onDisk.includes(localSetupItemKey(planRow.download));
      out[rowId] = { status: onDisk ? "done" : "waiting", percent: onDisk ? 100 : 0 };
    }
    return out;
  }, [plan, state]);

  const start = useCallback(() => dispatch({ type: "start" }), []);
  const retry = useCallback((rowId: LocalSetupRowId) => dispatch({ type: "retry", rowId }), []);

  return {
    rows,
    started: state.started,
    allDone: allEnabledDone(state),
    onDisk: state.onDisk,
    start,
    retry,
  };
}
