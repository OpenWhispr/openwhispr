import { create } from "zustand";
import { TFunction } from "i18next";
import type { ActionItem } from "../types/electron";

interface ActionState {
  actions: ActionItem[];
}

const useActionStore = create<ActionState>()(() => ({
  actions: [],
}));

let hasBoundIpcListeners = false;

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") return;

  const disposers: Array<() => void> = [];

  if (window.electronAPI?.onActionCreated) {
    const dispose = window.electronAPI.onActionCreated((action) => {
      if (action) addActionToStore(action);
    });
    if (typeof dispose === "function") disposers.push(dispose);
  }

  if (window.electronAPI?.onActionUpdated) {
    const dispose = window.electronAPI.onActionUpdated((action) => {
      if (action) updateActionInStore(action);
    });
    if (typeof dispose === "function") disposers.push(dispose);
  }

  if (window.electronAPI?.onActionDeleted) {
    const dispose = window.electronAPI.onActionDeleted(({ id }) => {
      removeActionFromStore(id);
    });
    if (typeof dispose === "function") disposers.push(dispose);
  }

  hasBoundIpcListeners = true;
  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function initializeActions(): Promise<ActionItem[]> {
  ensureIpcListeners();
  const items = (await window.electronAPI?.getActions()) ?? [];
  useActionStore.setState({ actions: items });
  return items;
}

function addActionToStore(action: ActionItem): void {
  const { actions } = useActionStore.getState();
  const withoutDuplicate = actions.filter((a) => a.id !== action.id);
  useActionStore.setState({
    actions: [...withoutDuplicate, action].sort((a, b) => a.sort_order - b.sort_order),
  });
}

function updateActionInStore(action: ActionItem): void {
  const { actions } = useActionStore.getState();
  useActionStore.setState({ actions: actions.map((a) => (a.id === action.id ? action : a)) });
}

function removeActionFromStore(id: number): void {
  const { actions } = useActionStore.getState();
  const next = actions.filter((a) => a.id !== id);
  if (next.length === actions.length) return;
  useActionStore.setState({ actions: next });
}

export function useActions(): ActionItem[] {
  return useActionStore((state) => state.actions);
}

export function getActionName(
  action: { name: string; translation_key?: string },
  t: TFunction
): string {
  return action.translation_key
    ? t(`${action.translation_key}.name`, { defaultValue: action.name })
    : action.name;
}

export function getActionDescription(
  action: { description: string; translation_key?: string },
  t: TFunction
): string {
  return action.translation_key
    ? t(`${action.translation_key}.description`, { defaultValue: action.description })
    : action.description;
}
