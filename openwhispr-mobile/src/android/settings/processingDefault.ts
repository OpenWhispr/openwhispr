import { create } from 'zustand';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { InferenceMode, InferenceSelection } from '@/lib/mobileProviders';
import { getProviderCredentialReference } from '@/services/providers/ProviderCredentials';
import type { UserConfig } from '@/types';
import { upgradeSavedModels } from './androidModels';
import type { KeyProviderId } from './keyCheck';
import { SHEET_TASKS, providerCanRun, startingModel, type SheetTask } from './ownKey';

/**
 * The "Default for every task" (Processing v2, Josh, 18 Nov). It sets every task at once;
 * changing one task afterwards changes only that task. There is no Local Mode on Android any
 * more: On device as the Default just puts every task on the phone.
 */
export type ProcessingDefault = { mode: InferenceMode; providerId?: KeyProviderId };

const KEY = 'android-processing-default-v1';

function saved(): ProcessingDefault {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ProcessingDefault | null;
    if (value && ['openwhispr', 'local', 'providers'].includes(value.mode)) return value;
  } catch {
    // Unreadable: start from Cloud, as a fresh install does.
  }
  return { mode: 'openwhispr' };
}

export const useProcessingDefault = create<ProcessingDefault>(() => saved());

function hasSaved(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Before this setting existed the Default was the app mode, so the first run seeds it from
 * there: a key mode keeps the key dictation runs on. (Local Mode is handled by leaveLocalMode.)
 */
function seedDefault(): void {
  if (hasSaved()) return;
  const { activeMode } = useProcessingModeStore.getState();
  const dictation = useConfigStore.getState().config?.inference?.dictation;
  if (activeMode === 'providers' && dictation?.mode === 'providers' && dictation.providerId)
    remember({ mode: 'providers', providerId: dictation.providerId as KeyProviderId });
  else if (activeMode === 'cloud') remember({ mode: 'openwhispr' });
}

function remember(value: ProcessingDefault) {
  useProcessingDefault.setState(value, true);
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Kept in memory for this run.
  }
}

/** The config change that gives one task its own choice, and nothing else. */
function taskChange(
  config: UserConfig | null,
  task: SheetTask,
  selection: InferenceSelection,
): Partial<UserConfig> {
  const change: Partial<UserConfig> = { inference: { ...config?.inference, [task]: selection } };
  if (task !== 'meeting' && selection.providerId)
    change.rememberedInference = {
      ...config?.rememberedInference,
      [task]: { ...config?.rememberedInference?.[task], [selection.providerId]: selection },
    };
  // A task the user chose is no longer held on Cloud automatically.
  if (task !== 'meeting' && config?.pinnedInference?.includes(task))
    change.pinnedInference = config.pinnedInference.filter((item) => item !== task);
  return change;
}

/** Runs one task on Cloud, on the phone, or on a saved key, leaving every other task alone. */
export async function setTask(task: SheetTask, selection: InferenceSelection): Promise<void> {
  const { config, updateConfig } = useConfigStore.getState();
  await updateConfig(taskChange(config, task, selection));
}

export async function keySelection(
  provider: KeyProviderId,
  task: SheetTask,
  modelId = startingModel(provider, task),
): Promise<InferenceSelection> {
  return {
    mode: 'providers',
    providerId: provider,
    modelId,
    credentialRef: await getProviderCredentialReference(provider),
  };
}

/**
 * Makes `next` the Default and moves every task onto it. A key only takes the tasks its
 * provider can run; the rest stay where they are.
 */
export async function applyDefault(next: ProcessingDefault): Promise<void> {
  let change: Partial<UserConfig> = {};
  let config = useConfigStore.getState().config;
  for (const task of SHEET_TASKS) {
    let selection: InferenceSelection;
    if (next.mode === 'providers') {
      if (!next.providerId || !providerCanRun(next.providerId, task)) continue;
      selection = await keySelection(next.providerId, task);
    } else selection = { mode: next.mode };
    change = { ...change, ...taskChange(config, task, selection) };
    config = { ...config, ...change } as UserConfig;
  }
  await useConfigStore.getState().updateConfig(change);
  remember(next);
  keepModeOpen();
}

/** Records the Default without moving any task (the key sheet applies its own ticks). */
export function markDefault(next: ProcessingDefault): void {
  remember(next);
  keepModeOpen();
}

/**
 * The app-wide mode stays out of Local Mode, whose locks would tie the tasks together. A key
 * Default keeps the providers mode, so a task left unset waits for a provider as before.
 */
function keepModeOpen() {
  const mode = useProcessingDefault.getState().mode === 'providers' ? 'providers' : 'cloud';
  const { activeMode, setActiveMode } = useProcessingModeStore.getState();
  if (activeMode !== mode) setActiveMode(mode, true);
  if (useConfigStore.getState().config?.defaultMode !== mode)
    void useConfigStore.getState().updateConfig({ defaultMode: mode });
}

/**
 * Anything that still turns Local Mode on (onboarding, an older build's setting) becomes the
 * On device Default instead: every task is put on the phone, except a cleanup or note
 * formatting choice already saved for a key, which Local Mode honoured too.
 */
export async function leaveLocalMode(): Promise<void> {
  const config = useConfigStore.getState().config;
  let change: Partial<UserConfig> = {};
  let next = config;
  for (const task of SHEET_TASKS) {
    const saved = config?.inference?.[task];
    if ((task === 'cleanup' || task === 'notes') && saved?.mode === 'providers') continue;
    change = { ...change, ...taskChange(next, task, { mode: 'local' }) };
    next = { ...next, ...change } as UserConfig;
  }
  remember({ mode: 'local' });
  await useConfigStore.getState().updateConfig({ ...change, defaultMode: 'cloud' });
  useProcessingModeStore.getState().setActiveMode('cloud', true);
}

let watching = false;
/** Turns Local Mode, whenever something enters it, into the On device Default. */
export function watchLocalMode(): void {
  if (watching) return;
  watching = true;
  let upgraded = false;
  const check = (mode: string) => {
    if (!useConfigStore.getState().config) return;
    if (mode === 'private') void leaveLocalMode();
    else seedDefault();
    // Saved choices on retired or retiring models move to their replacements, once a launch.
    if (!upgraded) {
      upgraded = true;
      void upgradeSavedModels();
    }
  };
  check(useProcessingModeStore.getState().activeMode);
  useProcessingModeStore.subscribe((state) => check(state.activeMode));
  // Config loads after start-up; the mode is reset from it then.
  useConfigStore.subscribe((state, previous) => {
    if (state.config && !previous.config) check(useProcessingModeStore.getState().activeMode);
  });
}

/** True when the task runs a different engine (or key) from the Default. */
export function differsFromDefault(
  selection: InferenceSelection | undefined,
  fallback: InferenceMode,
  value: ProcessingDefault,
): boolean {
  const mode = selection?.mode ?? fallback;
  if (mode !== value.mode) return true;
  return mode === 'providers' && selection?.providerId !== value.providerId;
}
