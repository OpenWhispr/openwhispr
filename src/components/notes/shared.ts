import { cn } from "../lib/utils";
import type { FolderItem } from "../../types/electron";

export const DEFAULT_FOLDER_NAME = "Personal";
export const MEETINGS_FOLDER_NAME = "Meetings";
export const VIDEOS_FOLDER_NAME = "Videos";

const DEFAULT_FOLDER_LABEL_KEYS: Record<string, string> = {
  [DEFAULT_FOLDER_NAME]: "notes.folders.defaults.personal",
  [MEETINGS_FOLDER_NAME]: "notes.folders.defaults.meetings",
  [VIDEOS_FOLDER_NAME]: "notes.folders.defaults.videos",
};

export function defaultFolderDisplayName(
  folder: Pick<FolderItem, "name" | "is_default">,
  t: (key: string) => string
): string {
  if (!folder.is_default) return folder.name;
  const key = DEFAULT_FOLDER_LABEL_KEYS[folder.name];
  return key ? t(key) : folder.name;
}

// Command search accepts either the presented label or the canonical stored
// name, so "meet" and "اجتماع" both find the default Meetings folder.
export function folderMatchesQuery(
  folder: Pick<FolderItem, "name" | "is_default">,
  t: (key: string) => string,
  query: string
): boolean {
  const q = query.toLowerCase();
  return (
    folder.name.toLowerCase().includes(q) ||
    defaultFolderDisplayName(folder, t).toLowerCase().includes(q)
  );
}

export function findDefaultFolder(folders: FolderItem[]): FolderItem | undefined {
  return folders.find((f) => f.name === DEFAULT_FOLDER_NAME && f.is_default);
}

// URL downloads route to "Videos" by name: a pre-existing user-created folder with
// that name is used as-is (the migration never promotes or replaces it).
export function findVideosFolder(folders: FolderItem[]): FolderItem | undefined {
  return folders.find((f) => f.name === VIDEOS_FOLDER_NAME);
}

// URL-download error codes → notes.upload.* i18n keys.
export const DOWNLOAD_ERROR_KEYS: Record<string, string> = {
  INVALID_URL: "urlInvalid",
  VIDEO_UNAVAILABLE: "urlVideoUnavailable",
  PLAYLIST_URL: "urlPlaylistNotSupported",
  CONTENT_TYPE_INVALID: "urlContentTypeInvalid",
  DOWNLOAD_FAILED: "urlDownloadFailed",
  FILE_TOO_LARGE: "urlFileTooLarge",
  YOUTUBE_BLOCKED: "urlYoutubeBlocked",
  SSRF_BLOCKED: "urlDownloadFailed",
};

// Transcription error codes → notes.upload.* i18n keys. Codes absent here fall
// back to the raw main-process message.
const TRANSCRIPTION_ERROR_KEYS: Record<string, string> = {
  NO_SPEECH_DETECTED: "noSpeechDetected",
  CHUNK_LOSS_EXCEEDED: "chunkLossExceeded",
  CUSTOM_ENDPOINT_INVALID: "customEndpointInvalid",
  STREAMING_ONLY_PROVIDER: "streamingOnlyProvider",
};

// A coded failure arrives either as a returned result (BYOK, local) or as a
// thrown error — OpenWhispr Cloud rethrows it through withSessionRefresh — so
// every call site resolves the key from whichever shape it is holding.
export function transcriptionErrorKey(failure: unknown): string | undefined {
  const code = (failure as { code?: string } | null | undefined)?.code;
  return code ? TRANSCRIPTION_ERROR_KEYS[code] : undefined;
}

// A finished recording that has a transcript but no AI summary yet offers to
// generate one. Deliberately independent of the open view tab: the callout lives
// in the bottom bar shared by Notes and Transcript, and every detected or
// quick-action meeting starts on the Notes tab, so gating it on the transcript
// view hid the offer exactly when a meeting ended on its own.
export function shouldOfferMeetingSummary({
  isRecording,
  hasTranscriptSegments,
  hasSummary,
  canEdit,
  isProcessingAction,
}: {
  isRecording: boolean;
  hasTranscriptSegments: boolean;
  hasSummary: boolean;
  canEdit: boolean;
  isProcessingAction: boolean;
}): boolean {
  return !isRecording && hasTranscriptSegments && !hasSummary && canEdit && !isProcessingAction;
}

// Folder scopes get the folder-specific empty title; space roots keep the generic one.
export function notesEmptyTitleKey(inFolder: boolean): string {
  return inFolder ? "notes.empty.emptyFolder" : "notes.empty.title";
}

export const notesInputClass = cn(
  "w-full h-8 px-3 rounded-md text-xs",
  "bg-foreground/3 dark:bg-white/4 border border-border/70 dark:border-white/10",
  "text-foreground/80 placeholder:text-foreground/45 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);

export const notesTextareaClass = cn(
  "w-full px-3 py-2 rounded-md text-xs leading-relaxed resize-none",
  "bg-foreground/3 dark:bg-white/4 border border-border/70 dark:border-white/10",
  "text-foreground/80 placeholder:text-foreground/45 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);

/** Neutral capsule for note header facts (date + attendees, folder, space). */
export const NOTE_META_CHIP_CLASS = cn(
  "inline-flex h-[26px] items-center gap-2 rounded-full bg-surface-3 px-2.5 text-xs font-medium text-foreground/70",
  "hover:bg-surface-raised hover:text-foreground dark:bg-surface-2 dark:hover:bg-surface-3",
  "cursor-pointer outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring/30"
);
