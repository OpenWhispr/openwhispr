import { create } from "zustand";
import type { SkillCreateInput, SkillSummary } from "../types/skills";

/** What Create skill holds, kept here so it survives leaving the page. */
export type SkillCreateDraft = SkillCreateInput;

interface SkillsState {
  skills: SkillSummary[];
  loaded: boolean;
  loadError: boolean;
  createDraft: SkillCreateDraft | null;
  /** Bumped to play a skill's icon once; see components/skills/SkillIcon. */
  iconPlays: Record<string, number>;
}

export const useSkillsStore = create<SkillsState>(() => ({
  skills: [],
  loaded: false,
  loadError: false,
  createDraft: null,
  iconPlays: {},
}));

let subscribed = false;
let loading: Promise<void> | null = null;
let reloadRequested = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  window.electronAPI?.onSkillsChanged?.(() => void refreshSkills());
}

/**
 * The library rereads its folder on every list, so while the Skills page shows, an edit made
 * outside the app appears when the window comes back into focus. Returns the way to stop.
 */
export function refreshSkillsOnFocus(): () => void {
  const reread = () => void refreshSkills();
  window.addEventListener("focus", reread);
  return () => window.removeEventListener("focus", reread);
}

/** Reloads the list. A refresh asked for during a load runs once that load finishes. */
export function refreshSkills(): Promise<void> {
  subscribe();
  if (loading) {
    reloadRequested = true;
    return loading;
  }
  loading = (async () => {
    try {
      do {
        reloadRequested = false;
        const result = await window.electronAPI?.skillsList?.();
        useSkillsStore.setState({ skills: result?.skills ?? [], loaded: true, loadError: false });
      } while (reloadRequested);
    } catch {
      useSkillsStore.setState({ loadError: true });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function setCreateDraft(createDraft: SkillCreateDraft | null): void {
  useSkillsStore.setState({ createDraft });
}

export function playSkillIcon(name: string): void {
  useSkillsStore.setState((state) => ({
    iconPlays: { ...state.iconPlays, [name]: (state.iconPlays[name] ?? 0) + 1 },
  }));
}

/**
 * Switching a skill on plays its icon. A switch that fails, as for a skill that needs fixing,
 * returns false and reloads the list, which may have changed on disk.
 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
  const result = await window.electronAPI?.skillsSetEnabled?.(name, enabled).catch(() => null);
  if (!result?.ok) {
    void refreshSkills();
    return false;
  }
  useSkillsStore.setState((state) => ({
    skills: state.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
  }));
  if (enabled) playSkillIcon(name);
  return true;
}
