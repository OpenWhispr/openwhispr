import type { ModelType } from "./useModelDownload";

export const MODEL_DOWNLOAD_CANCELLATION_KEY = "openwhisprModelDownloadCancellationV1";
export const MODEL_DOWNLOAD_CANCELLATION_EVENT = "openwhispr-model-download-cancelled";

export interface ModelDownloadCancellation {
  modelType: ModelType;
  modelId: string;
  nonce: number;
}

function parseCancellation(value: string | null): ModelDownloadCancellation | null {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<ModelDownloadCancellation> | null;
    if (
      !parsed ||
      !["whisper", "parakeet", "llm"].includes(parsed.modelType ?? "") ||
      typeof parsed.modelId !== "string" ||
      typeof parsed.nonce !== "number"
    ) {
      return null;
    }
    return parsed as ModelDownloadCancellation;
  } catch {
    return null;
  }
}

export function notifyModelDownloadCancellation(modelType: ModelType, modelId: string): void {
  const detail = { modelType, modelId, nonce: Date.now() } satisfies ModelDownloadCancellation;
  localStorage.setItem(MODEL_DOWNLOAD_CANCELLATION_KEY, JSON.stringify(detail));
  window.dispatchEvent(new CustomEvent(MODEL_DOWNLOAD_CANCELLATION_EVENT, { detail }));
}

export function readModelDownloadCancellationEvent(
  event: Event | StorageEvent
): ModelDownloadCancellation | null {
  if (event.type === "storage") {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== MODEL_DOWNLOAD_CANCELLATION_KEY) return null;
    return parseCancellation(storageEvent.newValue);
  }
  return (event as CustomEvent<ModelDownloadCancellation>).detail ?? null;
}
