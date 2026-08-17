import { create } from "zustand";
import type { TranscriptionCursor, TranscriptionItem } from "../types/electron";

interface TranscriptionState {
  transcriptions: TranscriptionItem[];
  includeDiscarded: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
}

const useTranscriptionStore = create<TranscriptionState>()(() => ({
  transcriptions: [],
  includeDiscarded: false,
  hasMore: false,
  isLoadingMore: false,
}));

let hasBoundIpcListeners = false;
const PAGE_SIZE = 50;
// Keyset cursor of the oldest loaded row; null while on the first page.
let nextCursor: TranscriptionCursor | null = null;
let requestGeneration = 0;

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI?.onTranscriptionAdded) {
    const dispose = window.electronAPI.onTranscriptionAdded((item) => {
      if (item) {
        addTranscription(item);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionDeleted) {
    const dispose = window.electronAPI.onTranscriptionDeleted(({ id }) => {
      removeTranscription(id);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionUpdated) {
    const dispose = window.electronAPI.onTranscriptionUpdated((item) => {
      if (item) {
        updateTranscription(item);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionsCleared) {
    const dispose = window.electronAPI.onTranscriptionsCleared(() => {
      clearTranscriptions();
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function initializeTranscriptions(
  limit = PAGE_SIZE,
  includeDiscarded = useTranscriptionStore.getState().includeDiscarded
) {
  ensureIpcListeners();
  const generation = ++requestGeneration;
  const page = await window.electronAPI.getTranscriptionsPage({ limit, includeDiscarded });
  if (generation !== requestGeneration) return useTranscriptionStore.getState().transcriptions;
  nextCursor = page.nextCursor;
  useTranscriptionStore.setState({
    transcriptions: page.items,
    includeDiscarded,
    hasMore: page.hasMore,
    isLoadingMore: false,
  });
  return page.items;
}

export async function loadMoreTranscriptions() {
  const { hasMore, isLoadingMore, includeDiscarded } = useTranscriptionStore.getState();
  if (!hasMore || isLoadingMore) return;
  const generation = requestGeneration;
  const cursor = nextCursor;
  useTranscriptionStore.setState({ isLoadingMore: true });
  try {
    const page = await window.electronAPI.getTranscriptionsPage({
      limit: PAGE_SIZE,
      cursor,
      includeDiscarded,
    });
    if (generation !== requestGeneration) return;
    nextCursor = page.nextCursor;
    // Re-read state after the await: live events (add/update/delete) that
    // landed while the page was in flight must not be clobbered. Live
    // transcription-added events prepend rows that page fetches can overlap,
    // so append by id only.
    const { transcriptions: current } = useTranscriptionStore.getState();
    const existingIds = new Set(current.map((item) => item.id));
    const appended = page.items.filter((item) => !existingIds.has(item.id));
    useTranscriptionStore.setState({
      transcriptions: [...current, ...appended],
      hasMore: page.hasMore,
    });
  } catch {
    // Keep hasMore so scrolling again retries the failed page.
  } finally {
    useTranscriptionStore.setState({ isLoadingMore: false });
  }
}

export function addTranscription(item: TranscriptionItem) {
  if (!item) return;
  if (item.status === "discarded" && !useTranscriptionStore.getState().includeDiscarded) return;
  const { transcriptions } = useTranscriptionStore.getState();
  const withoutDuplicate = transcriptions.filter((existing) => existing.id !== item.id);
  useTranscriptionStore.setState({
    transcriptions: [item, ...withoutDuplicate],
  });
}

export function removeTranscription(id: number) {
  if (id == null) return;
  const { transcriptions } = useTranscriptionStore.getState();
  const next = transcriptions.filter((item) => item.id !== id);
  if (next.length === transcriptions.length) return;
  useTranscriptionStore.setState({ transcriptions: next });
}

export function updateTranscription(item: TranscriptionItem) {
  if (!item) return;
  const { transcriptions, includeDiscarded } = useTranscriptionStore.getState();
  if (item.status === "discarded" && !includeDiscarded) {
    removeTranscription(item.id);
    return;
  }
  const next = transcriptions.map((existing) => (existing.id === item.id ? item : existing));
  useTranscriptionStore.setState({ transcriptions: next });
}

export function clearTranscriptions() {
  requestGeneration++;
  nextCursor = null;
  useTranscriptionStore.setState({
    transcriptions: [],
    hasMore: false,
    isLoadingMore: false,
  });
}

export function useTranscriptions() {
  return useTranscriptionStore((state) => state.transcriptions);
}

export function useShowDiscarded() {
  return useTranscriptionStore((state) => state.includeDiscarded);
}

export function useHasMoreTranscriptions() {
  return useTranscriptionStore((state) => state.hasMore);
}

export function useIsLoadingMoreTranscriptions() {
  return useTranscriptionStore((state) => state.isLoadingMore);
}
