import { create } from "zustand";
import type { ConnectorStatus } from "../types/connectors";

interface ConnectorStatusState {
  statuses: Record<string, ConnectorStatus>;
  loaded: boolean;
}

export const useConnectorStatusStore = create<ConnectorStatusState>(() => ({
  statuses: {},
  loaded: false,
}));

function apply(list: ConnectorStatus[] | null | undefined): void {
  const statuses: Record<string, ConnectorStatus> = {};
  for (const status of Array.isArray(list) ? list : []) statuses[status.id] = status;
  useConnectorStatusStore.setState({ statuses, loaded: true });
}

let subscribed = false;
let loading: Promise<void> | null = null;
// Bumped by every broadcast from main. A load that started before the latest
// broadcast carries an older snapshot and is dropped.
let revision = 0;

export function refreshConnectorStatus(): Promise<void> {
  if (!loading) {
    const startedAt = revision;
    loading = (async () => {
      try {
        const list = await window.electronAPI?.connectorStatus?.();
        if (revision === startedAt) apply(list);
      } catch {
        // Unknown means not connected. `loaded` stays false, so the next
        // ensureConnectorStatus() tries again.
        if (revision === startedAt) useConnectorStatusStore.setState({ statuses: {} });
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

/** Subscribes once per window, then loads until one load succeeds. */
export async function ensureConnectorStatus(): Promise<void> {
  if (!subscribed) {
    subscribed = true;
    window.electronAPI?.onConnectorStatusChanged?.((statuses) => {
      revision += 1;
      apply(statuses);
    });
  }
  if (!useConnectorStatusStore.getState().loaded) await refreshConnectorStatus();
}

/** Connected, and not waiting on a reconnect. */
export function isConnectorReady(id: string): boolean {
  const status = useConnectorStatusStore.getState().statuses[id];
  return Boolean(status?.connected && !status.needsReconnect);
}
