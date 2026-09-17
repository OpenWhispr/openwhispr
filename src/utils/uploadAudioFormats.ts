import { UPLOAD_AUDIO_EXTENSIONS } from "../constants/uploadAudioFormats.json";

export function isSupportedUploadFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && UPLOAD_AUDIO_EXTENSIONS.includes(fileName.slice(dot + 1).toLowerCase());
}

// Matches a URL whose path ends in an uploadable extension (query string allowed).
export const uploadFileUrlPattern = new RegExp(
  `\\.(${UPLOAD_AUDIO_EXTENSIONS.join("|")})(\\?|$)`,
  "i"
);
