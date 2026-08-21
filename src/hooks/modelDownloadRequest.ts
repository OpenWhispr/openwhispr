export interface ModelDownloadTerminalEvent {
  type: "complete" | "error";
  modelId: string;
  error?: string;
  code?: string;
}

export interface PendingModelDownloadRequest {
  modelId: string;
  terminalEvent?: ModelDownloadTerminalEvent;
  awaitingTerminalEvent: boolean;
  settled: boolean;
  onSelect?: (modelId: string) => void;
  onError?: (error: string) => void;
}

export interface ModelDownloadRequestCallbacks {
  onSelect?: (modelId: string) => void;
  onError?: (error: string) => void;
}

export function createModelDownloadRequest(
  modelId: string,
  callbacks: ModelDownloadRequestCallbacks
): PendingModelDownloadRequest {
  return {
    modelId,
    awaitingTerminalEvent: false,
    settled: false,
    ...callbacks,
  };
}

export function attachModelDownloadRequestToActive(
  activeRequest: PendingModelDownloadRequest | null,
  activeModelId: string | null,
  requestedModelId: string,
  callbacks: ModelDownloadRequestCallbacks
): {
  outcome: "available" | "joined-same" | "busy-other";
  request: PendingModelDownloadRequest | null;
} {
  if (!activeModelId) return { outcome: "available", request: null };
  if (activeModelId !== requestedModelId) {
    return { outcome: "busy-other", request: activeRequest };
  }
  const request = activeRequest ?? createModelDownloadRequest(requestedModelId, callbacks);
  request.onSelect = callbacks.onSelect;
  request.onError = callbacks.onError;
  request.awaitingTerminalEvent = true;
  return { outcome: "joined-same", request };
}

export function settleModelDownloadOriginSuccess(request: PendingModelDownloadRequest): boolean {
  if (request.settled) return false;
  request.settled = true;
  request.onSelect?.(request.modelId);
  return true;
}

export function routeModelDownloadTerminalEvent(
  request: PendingModelDownloadRequest,
  terminalEvent: ModelDownloadTerminalEvent,
  handlers: {
    formatError: (event: ModelDownloadTerminalEvent) => string;
    applyTerminal: (
      event: ModelDownloadTerminalEvent,
      result: { requestErrorHandled: boolean }
    ) => void;
  }
): "deferred" | "settled" | "ignored" {
  if (request.modelId !== terminalEvent.modelId || request.settled) return "ignored";
  if (!request.awaitingTerminalEvent) {
    request.terminalEvent = terminalEvent;
    return "deferred";
  }
  request.settled = true;
  if (terminalEvent.type === "complete") request.onSelect?.(terminalEvent.modelId);
  else request.onError?.(handlers.formatError(terminalEvent));
  handlers.applyTerminal(terminalEvent, {
    requestErrorHandled: terminalEvent.type === "error" && Boolean(request.onError),
  });
  return "settled";
}
