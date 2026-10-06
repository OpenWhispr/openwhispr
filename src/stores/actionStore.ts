import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { TFunction } from "i18next";
import type { ActionItem, ActionKind } from "../types/electron";
import { DETAILED_NOTES_KEY } from "../helpers/builtinActions";

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

export function useActionsOfKind(kind: ActionKind): ActionItem[] {
  return useActionStore(useShallow((state) => state.actions.filter((a) => a.kind === kind)));
}

/**
 * The template a summary is written with: the note's own, else the default AI
 * Summary. An id can outlive its template or belong to a teammate's, so it is
 * only a preference.
 */
export function resolveTemplate(
  templates: ActionItem[],
  clientId: string | null | undefined
): ActionItem | null {
  return (
    templates.find((a) => a.client_id === clientId) ??
    templates.find((a) => a.translation_key === DETAILED_NOTES_KEY) ??
    templates[0] ??
    null
  );
}

export function getActionName(
  action: { name: string; translation_key?: string },
  t: TFunction
): string {
  return action.translation_key
    ? t(`${action.translation_key}.name`, { defaultValue: action.name })
    : action.name;
}

/** Verb-form label the chat shows for a running action; falls back to the action name. */
export function getActionCta(
  action: { name: string; translation_key?: string },
  t: TFunction
): string {
  return action.translation_key
    ? t(`${action.translation_key}.cta`, { defaultValue: getActionName(action, t) })
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
