import { usePolicyStore } from "../stores/policyStore";
import {
  useSettingsStore,
  selectResolvedUploadTranscription,
  selectPolicyEffectiveSettings,
} from "../stores/settingsStore";
import { isTranscriptionContextAllowed } from "../stores/policyRules";
import {
  transcribeFileWithSpeakers,
  type FileTranscriptionConfig,
  type DiarizationSettings,
} from "./fileTranscription";
import { saveUploadNote, uploadTitleFallback } from "./uploadNotes";
import { findDefaultFolder } from "../components/notes/shared";

export interface CliAudioImportOutcome {
  status: "completed" | "failed" | "cancelled";
  noteId?: number;
  title?: string;
  text?: string;
  durationSeconds?: number | null;
  error?: string;
  code?: string;
}

export interface CliAudioImportCommitResult {
  ok: boolean;
  reason?: string;
}

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

// Runs the CLI-import path through the exact same
// transcribeFileWithSpeakers -> saveUploadNote pipeline UploadAudioView uses
// for a user-picked file, so a CLI-submitted job produces a normal, visible
// upload note in Personal Notes — never a second, headless persistence
// route. Deliberately narrower than the full UI flow, as a documented POC
// limitation rather than a missing feature:
//   - diarization is always off: the UI's "are local sherpa-onnx models
//     ready" check is component state (mount-time effect + localStorage)
//     with no equivalent outside a mounted component.
//   - title is always the plain-text uploadTitleFallback, never the
//     LLM-generated title, so a CLI import never calls a remote model.
//   - duration is left for the provider to report rather than pre-computed
//     from the source file the way a picked browser File's metadata is.
export async function runCliAudioImport(
  filePath: string,
  requestId: string,
  shouldAbort: () => boolean = () => false,
  beginPersist: () => Promise<CliAudioImportCommitResult> = async () => ({ ok: true })
): Promise<CliAudioImportOutcome> {
  const policyState = usePolicyStore.getState();
  // The same policy-effective view UploadAudioView reads from (its own
  // "upload" checks read getSettings(), which is exactly this overlay —
  // see settingsStore.ts#getSettings): a managed org policy that forces
  // upload transcription local/nonlocal must apply identically here, not
  // just to the raw, possibly-stale unmanaged preference.
  const settings = selectPolicyEffectiveSettings(useSettingsStore.getState(), policyState);

  if (!isTranscriptionContextAllowed(policyState, settings, "upload")) {
    return {
      status: "failed",
      error: "Upload transcription is managed by org policy",
      code: "POLICY_BLOCKED",
    };
  }

  // Snapshot of the CURRENTLY configured (policy-effective) upload
  // transcription settings, so a CLI import always honors whatever is
  // actually in effect right now.
  const resolved = selectResolvedUploadTranscription(settings);
  if (!resolved.useLocalWhisper) {
    return {
      status: "failed",
      error:
        "Configured upload transcription is not local; the CLI-import bridge only runs the local pipeline",
      code: "NOT_LOCAL",
    };
  }

  const cfg: FileTranscriptionConfig = {
    useLocalWhisper: true,
    localTranscriptionProvider: resolved.localTranscriptionProvider,
    whisperModel: resolved.whisperModel,
    parakeetModel: resolved.parakeetModel,
    cohereModel: resolved.cohereModel,
    // transcribeFile only reads the local-provider fields above once useLocalWhisper
    // is true — these remain inert, satisfying FileTranscriptionConfig's
    // shape without exercising any cloud/BYOK branch.
    isOpenWhisprCloud: false,
    getApiKey: () => "",
    cloudTranscriptionProvider: "",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "",
    language: "",
  };

  const diarization: DiarizationSettings = {
    enabled: false,
    localModelsReady: false,
    numSpeakers: null,
  };

  const result = await transcribeFileWithSpeakers(filePath, cfg, diarization, null, {
    requestId,
    timestamps: true,
  });

  if (result.code === "UPLOAD_CANCELLED") {
    return { status: "cancelled" };
  }
  if (!result.success || !result.text) {
    return {
      status: "failed",
      error: result.error || "Local transcription produced no text",
      code: result.code,
    };
  }

  // Fast local check: skips an unnecessary getFolders() round trip when a
  // cancel has already been latched locally (see useCliAudioImportHost).
  // This is an optimization only — the real commit-vs-cancel race is
  // resolved authoritatively by beginPersist() below.
  if (shouldAbort()) {
    return { status: "cancelled" };
  }

  const fileName = basenameOf(filePath);
  const title = uploadTitleFallback(result.text, fileName);

  // Uploads are a personal flow: scope folder resolution to the private
  // space exactly like UploadAudioView does (see its mount-time
  // getSpaces()/getFolders(privateSpace.id) effect), so a same-named team
  // folder can never capture a CLI-submitted note into a shared space.
  const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
  const privateSpace = spaces.find((space) => space.kind === "private");
  if (!privateSpace) {
    return {
      status: "failed",
      error: "Could not resolve the private Personal Notes space for this import",
      code: "NO_PRIVATE_SPACE",
    };
  }
  const folders = await window.electronAPI.getFolders(privateSpace.id);
  const folder = findDefaultFolder(folders);
  if (!folder) {
    return {
      status: "failed",
      error: "Could not resolve the private space's default folder for this import",
      code: "NO_DEFAULT_FOLDER",
    };
  }

  // Atomic commit point: only the main-process bridge (see
  // cliAudioImportBridge.js#beginPersist) can authoritatively decide
  // whether a CLI cancel has already won, since it may have recorded that
  // decision before this renderer even receives the cancel IPC message.
  // Only reason "cancelling" reflects a legitimate, bridge-recorded cancel
  // race won by the user's DELETE request — every other non-ok reason
  // (gate unreachable/malformed, job not recognized, etc.) is a system
  // fault, not a user cancel, and must be reported as an explicit failure
  // rather than silently mislabeled "cancelled". Either way, this import
  // must not create a note.
  let commit: CliAudioImportCommitResult;
  try {
    commit = await beginPersist();
  } catch (error) {
    return {
      status: "failed",
      error: (error as Error)?.message || "Failed to arm the commit point for this import",
      code: "BEGIN_PERSIST_ERROR",
    };
  }
  if (!commit.ok) {
    if (commit.reason === "cancelling") {
      return { status: "cancelled" };
    }
    return {
      status: "failed",
      error: `The commit gate refused this import (${commit.reason || "unknown"})`,
      code: "COMMIT_REJECTED",
    };
  }

  const noteRes = await saveUploadNote({
    title,
    text: result.text,
    sourceName: fileName,
    folderId: folder.id,
    diarization,
    durationSeconds: result.durationSeconds,
    segments: result.segments,
  });

  if (!noteRes.success || !noteRes.note) {
    return { status: "failed", error: "Failed to save upload note", code: "SAVE_NOTE_FAILED" };
  }

  return {
    status: "completed",
    noteId: noteRes.note.id,
    title,
    text: result.text,
    durationSeconds: result.durationSeconds ?? null,
  };
}
