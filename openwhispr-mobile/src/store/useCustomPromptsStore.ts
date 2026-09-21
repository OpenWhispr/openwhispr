import 'expo-sqlite/localStorage/install';
import { create } from 'zustand';
import {
  PROMPT_KIND_LIST,
  customPromptStorageKey,
  resolveCustomPrompt,
  type PromptKind,
} from '@/config/prompts/registry';
import { sweepRetiredPromptOverrides } from '@/config/prompts/retiredPrompts';

// Mobile addition for last-write-wins sync; desktop will grow the same key
// when sync lands.
function customPromptUpdatedAtKey(kind: PromptKind): string {
  return `${customPromptStorageKey(kind)}.updatedAt`;
}

type CustomPromptMap = Record<PromptKind, string>;
type UpdatedAtMap = Partial<Record<PromptKind, number>>;

interface CustomPromptsState {
  customPrompts: CustomPromptMap;
  updatedAt: UpdatedAtMap;
  setCustomPrompt: (kind: PromptKind, value: string, options?: { updatedAt?: number }) => void;
  resetCustomPrompt: (kind: PromptKind) => void;
  hydrate: () => void;
}

function emptyPrompts(): CustomPromptMap {
  return Object.fromEntries(PROMPT_KIND_LIST.map((kind) => [kind, ''])) as CustomPromptMap;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readPersisted(): Pick<CustomPromptsState, 'customPrompts' | 'updatedAt'> {
  const customPrompts = emptyPrompts();
  const updatedAt: UpdatedAtMap = {};
  const storage = getStorage();
  if (!storage) return { customPrompts, updatedAt };

  for (const kind of PROMPT_KIND_LIST) {
    try {
      const value = storage.getItem(customPromptStorageKey(kind));
      if (value !== null) customPrompts[kind] = value;
      const at = Number(storage.getItem(customPromptUpdatedAtKey(kind)));
      if (Number.isFinite(at) && at > 0) updatedAt[kind] = at;
    } catch {
      // Keep the defaults for this kind; a failing read must not block startup.
    }
  }
  return { customPrompts, updatedAt };
}

export const useCustomPromptsStore = create<CustomPromptsState>((set, get) => ({
  customPrompts: emptyPrompts(),
  updatedAt: {},
  hydrate: () => set(readPersisted()),
  setCustomPrompt: (kind, value, options) => {
    const at = options?.updatedAt ?? Date.now();
    try {
      const storage = getStorage();
      storage?.setItem(customPromptStorageKey(kind), value);
      storage?.setItem(customPromptUpdatedAtKey(kind), String(at));
    } catch (error) {
      console.warn(`[customPrompts] failed to persist ${kind}`, error);
    }
    set((state) => ({
      customPrompts: { ...state.customPrompts, [kind]: value },
      updatedAt: { ...state.updatedAt, [kind]: at },
    }));
  },
  resetCustomPrompt: (kind) => get().setCustomPrompt(kind, ''),
}));

// localStorage is synchronous, so hydrate at load: keyboard orphan recovery
// can run cleanup before any React effect has a chance to.
useCustomPromptsStore.getState().hydrate();

export function getActiveCustomCleanupPrompt(): string | undefined {
  return resolveCustomPrompt(useCustomPromptsStore.getState().customPrompts.cleanup);
}

// Clears overrides that byte-match a retired shipped default (see
// retiredPrompts.ts). Async and best-effort; never blocks startup. A sweep is
// not a user edit, so updatedAt is left alone.
export async function startRetiredPromptSweep(): Promise<PromptKind[]> {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const swept = await sweepRetiredPromptOverrides(storage, PROMPT_KIND_LIST);
    if (swept.length > 0) {
      useCustomPromptsStore.setState((state) => ({
        customPrompts: {
          ...state.customPrompts,
          ...Object.fromEntries(swept.map((kind) => [kind, ''])),
        },
      }));
      if (__DEV__) {
        console.log(`[customPrompts] cleared retired default overrides: ${swept.join(', ')}`);
      }
    }
    return swept;
  } catch (error) {
    console.warn('[customPrompts] retired prompt sweep failed', error);
    return [];
  }
}
