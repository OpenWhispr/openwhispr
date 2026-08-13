import { cn } from "../lib/utils";
import type { FolderItem } from "../../types/electron";

export const DEFAULT_FOLDER_NAME = "Personal";
export const MEETINGS_FOLDER_NAME = "Meetings";
export const VIDEOS_FOLDER_NAME = "Videos";

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
};

// A coded failure arrives either as a returned result (BYOK, local) or as a
// thrown error — OpenWhispr Cloud rethrows it through withSessionRefresh — so
// every call site resolves the key from whichever shape it is holding.
export function transcriptionErrorKey(failure: unknown): string | undefined {
  const code = (failure as { code?: string } | null | undefined)?.code;
  return code ? TRANSCRIPTION_ERROR_KEYS[code] : undefined;
}

// Folder scopes get the folder-specific empty title; space roots keep the generic one.
export function notesEmptyTitleKey(inFolder: boolean): string {
  return inFolder ? "notes.empty.emptyFolder" : "notes.empty.title";
}

export const notesInputClass = cn(
  "w-full h-8 px-3 rounded-md text-xs",
  "bg-foreground/3 dark:bg-white/4 border border-border/30 dark:border-white/6",
  "text-foreground/80 placeholder:text-foreground/20 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);

export const notesTextareaClass = cn(
  "w-full px-3 py-2 rounded-md text-xs leading-relaxed resize-none",
  "bg-foreground/3 dark:bg-white/4 border border-border/30 dark:border-white/6",
  "text-foreground/80 placeholder:text-foreground/20 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);
