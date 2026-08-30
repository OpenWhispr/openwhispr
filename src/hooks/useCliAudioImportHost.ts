import { useEffect, useRef } from "react";
import {
  runCliAudioImport,
  type CliAudioImportOutcome,
  type CliAudioImportCommitResult,
} from "../services/cliAudioImport";

type ElectronApi = Window["electronAPI"];

// The full surface this host requires to safely register with the bridge.
// Every member here must be an actual function on window.electronAPI, not
// merely "not undefined" — a partial/stale preload (e.g. mid-rollout, where
// some but not all of these were added) must be treated exactly like a
// fully absent one and stay unregistered, so bridge submissions fail with a
// clear renderer_unavailable up front instead of this host silently
// accepting work it can only partially carry out.
interface CliAudioImportHostApi {
  cliAudioImportHostReady: NonNullable<ElectronApi["cliAudioImportHostReady"]>;
  cliAudioImportHostUnready: NonNullable<ElectronApi["cliAudioImportHostUnready"]>;
  onCliAudioImportJob: NonNullable<ElectronApi["onCliAudioImportJob"]>;
  onCliAudioImportCancel: NonNullable<ElectronApi["onCliAudioImportCancel"]>;
  beginCliAudioImportPersist: NonNullable<ElectronApi["beginCliAudioImportPersist"]>;
  reportCliAudioImportResult: NonNullable<ElectronApi["reportCliAudioImportResult"]>;
  failCliAudioImportJob: NonNullable<ElectronApi["failCliAudioImportJob"]>;
}

const REQUIRED_CLI_AUDIO_IMPORT_METHODS = [
  "cliAudioImportHostReady",
  "cliAudioImportHostUnready",
  "onCliAudioImportJob",
  "onCliAudioImportCancel",
  "beginCliAudioImportPersist",
  "reportCliAudioImportResult",
  "failCliAudioImportJob",
] as const satisfies readonly (keyof CliAudioImportHostApi)[];

// Strict function-type check for every required method — not an `if
// (api?.x)` truthy/optional-chaining check, which would happily proceed
// with any subset present. A boolean `false` default value or a
// non-function placeholder must be treated the same as missing.
function getReadyCliAudioImportApi(): CliAudioImportHostApi | null {
  const api = window.electronAPI;
  const isComplete = REQUIRED_CLI_AUDIO_IMPORT_METHODS.every(
    (method) => typeof api?.[method] === "function"
  );
  return isComplete ? (api as CliAudioImportHostApi) : null;
}

// Always-mounted host for the CLI-import bridge (see cliAudioImportBridge.js
// on the main process side). Registers this renderer as the one target the
// bridge dispatches CLI-submitted jobs to, runs each job through the normal
// upload-note pipeline (see cliAudioImport.ts), and reports the outcome
// back — with no UI of its own, so a CLI import doesn't require the user to
// be on the Upload tab. Only ControlPanel mounts this, and only once.
export function useCliAudioImportHost(): void {
  const activeRequestIdRef = useRef<string | null>(null);
  // Latches that a cancel was requested for a given requestId, checked by
  // runCliAudioImport's shouldAbort callback at every point after
  // transcription up through (but not after) the actual note save. Needed
  // because activeRequestIdRef alone only tells a *later* cancel whether a
  // job is still running — it can't tell runCliAudioImport, mid-flight,
  // that a cancel arrived after transcription already resolved.
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const api = getReadyCliAudioImportApi();
    if (!api) return;

    api.cliAudioImportHostReady();

    const offJob = api.onCliAudioImportJob((job) => {
      activeRequestIdRef.current = job.requestId;
      const shouldAbort = () => cancelledRequestIdsRef.current.has(job.requestId);
      // Wires the atomic commit gate (see cliAudioImportBridge.js#beginPersist)
      // through to runCliAudioImport. This gate is the sole thing standing
      // between a cancel and an actual saveUploadNote call, so a
      // thrown/rejected/malformed call fails closed (ok:false) — it must
      // never be treated as tacit permission to persist a note.
      const beginPersist = async (): Promise<CliAudioImportCommitResult> => {
        let result: CliAudioImportCommitResult | undefined;
        try {
          result = await api.beginCliAudioImportPersist(job.jobId);
        } catch (error) {
          return {
            ok: false,
            reason: (error as Error)?.message || "begin_persist_ipc_failed",
          };
        }
        if (!result || result.ok !== true) {
          return { ok: false, reason: result?.reason || "begin_persist_rejected" };
        }
        return result;
      };
      runCliAudioImport(job.path, job.requestId, shouldAbort, beginPersist)
        .catch((error): CliAudioImportOutcome => ({
          status: "failed",
          error: error?.message || "Local audio import failed",
        }))
        .then(async (outcome) => {
          if (activeRequestIdRef.current === job.requestId) activeRequestIdRef.current = null;
          cancelledRequestIdsRef.current.delete(job.requestId);
          try {
            await api.reportCliAudioImportResult(job.jobId, outcome);
          } catch (error) {
            // The bridge never learns the real outcome above if delivering
            // it failed — without an authoritative fallback the job would
            // stay "transcribing"/"persisting" forever and a CLI --wait
            // would poll indefinitely. failCliAudioImportJob is scoped to
            // this exact job+requestId (see cliAudioImportBridge.js#failJob)
            // so it can never affect a different job.
            try {
              await api.failCliAudioImportJob(
                job.jobId,
                job.requestId,
                `failed to report import result: ${(error as Error)?.message || "unknown error"}`
              );
            } catch {
              // Nothing further can be done from here; the bridge's own
              // renderer-loss detection (destroyed / render-process-gone /
              // navigation) is the last line of defense if the IPC channel
              // itself is this broken.
            }
          }
        });
    });

    const offCancel = api.onCliAudioImportCancel(({ requestId }) => {
      if (activeRequestIdRef.current === requestId) {
        cancelledRequestIdsRef.current.add(requestId);
        window.electronAPI?.cancelUploadTranscription?.(requestId);
      }
    });

    return () => {
      offJob();
      offCancel();
      api.cliAudioImportHostUnready();
    };
  }, []);
}
