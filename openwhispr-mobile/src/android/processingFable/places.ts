import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { create } from 'zustand';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { CloudAccess } from '@/lib/inferenceModes';
import {
  getMobileProvidersForScope,
  type InferenceSelection,
} from '@/android/providers/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import { discoverProviderModels } from '@/services/providers/ProviderExecution';
import type { ProcessingMode, UserConfig } from '@/types';
import i18n from '../strings';
import {
  ANDROID_MODELS,
  cancelAndroidDownload,
  downloadAndroidModel,
  modelReady,
  removeAndroidModel,
  useModelDownloads,
  type AndroidModelId,
} from '../models';
import { LIVE_MODEL, isLiveProvider, meetingKey } from '../providers/liveMeeting';
import { KEY_CHECK_DELAY_MS, type KeyCheckResult, type KeyProviderId } from '../settings/keyCheck';
import {
  KEY_PROVIDERS,
  SHEET_TASKS,
  providerCanRun,
  providerModels,
  runTaskOnKey,
  saveKey,
  savedKey,
  type SheetTask,
} from '../settings/ownKey';
import {
  applyDefault,
  markDefault,
  setTask,
  useProcessingDefault,
  type ProcessingDefault,
} from '../settings/processingDefault';
import { effectiveSelection } from '../settings/processingTasks';
import { showToast } from '../settings/kit';
import { settingsT, type SettingsT } from '../settings/strings';
import type { LucideIconName } from '@/components/ui/SystemIcon';
import { fableT } from './strings';
import { canTranscribeMeetings } from '../speechSelection';
import { meetingModelRows } from '../settings/modelCatalog';

/**
 * Processing · Fable's take (test build, Josh approved 18 Nov). The screen is three places
 * (OpenWhispr Cloud, On device, Your own API key) holding the tasks they run. Every task still
 * runs its own engine (processingDefault.ts); this file says which place each task is in, and
 * moves tasks between places, with Undo for the bulk moves.
 */

export type Place = 'cloud' | 'device' | 'key';
/** A key's source: one of the providers, or the one custom server this phone knows. */
export type Source = KeyProviderId | 'custom';
export type Placement = { place: Place; source?: Source; modelId?: string };

export const TASK_TITLE = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
  agent: 'assistant',
  meeting: 'meetings',
} as const;

/** The Provider field's list, grouped by what each provider can run (6C2). */
export const SOURCE_GROUPS: {
  title: 'groupSpeechText' | 'groupSpeech' | 'groupText' | 'groupOwn';
  ids: Source[];
}[] = [
  { title: 'groupSpeechText', ids: ['openai', 'groq'] },
  { title: 'groupSpeech', ids: ['deepgram', 'assemblyai'] },
  { title: 'groupText', ids: ['openrouter'] },
  { title: 'groupOwn', ids: ['custom'] },
];

export function sourceName(source: string): string {
  if (source === 'custom') return fableT('customServer');
  return KEY_PROVIDERS.find((item) => item.id === source)?.name ?? source;
}

/** A custom server transcribes and writes text with whatever models it lists; never live. */
export function sourceCanRun(source: string, task: SheetTask): boolean {
  if (source === 'custom') {
    if (task === 'meeting') return false;
    const { speechModels, textModels } = useCustomServer.getState();
    return task === 'dictation' || task === 'upload'
      ? !!speechModels?.length
      : !!textModels?.length;
  }
  return providerCanRun(source, task);
}

/** The tasks a provider can run, in task order (5 OpenAI, 4 Groq, 3 Deepgram/AssemblyAI, 2 OpenRouter). */
export function sourceTasks(source: Source): SheetTask[] {
  return SHEET_TASKS.filter((task) => sourceCanRun(source, task));
}

/** Where a task runs now. Meetings default to Cloud; an unset key task counts as Cloud. */
export function placementOf(
  config: UserConfig | null,
  task: SheetTask,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): Placement {
  if (task === 'meeting') {
    const key = meetingKey();
    if (key) return { place: 'key', source: key.providerId, modelId: key.modelId };
    return { place: config?.inference?.meeting?.mode === 'local' ? 'device' : 'cloud' };
  }
  const selection = effectiveSelection(config, task, activeMode, cloudAccess);
  if (selection.mode === 'local') return { place: 'device' };
  if (selection.mode === 'providers' && selection.providerId)
    return {
      place: 'key',
      source: selection.providerId as Source,
      modelId: selection.modelId,
    };
  return { place: 'cloud' };
}

/**
 * Settings' Processing row: one place names it, one key names its source, different keys read
 * Your own API key, and anything else is Mixed. Text cleanup counts only while it is switched on.
 */
export function processingSummary(
  t: SettingsT,
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): { label: string; icon: LucideIconName } {
  const placements = SHEET_TASKS.filter(
    (task) => task !== 'cleanup' || (config?.cleanupEnabled ?? true),
  ).map((task) => placementOf(config, task, activeMode, cloudAccess));
  const [first] = placements;
  if (placements.some(({ place }) => place !== first.place))
    return { label: t('mixed'), icon: 'Split' };
  if (first.place === 'cloud') return { label: t('cloudShort'), icon: 'Cloud' };
  if (first.place === 'device') return { label: t('thisPhone'), icon: 'Smartphone' };
  const oneSource = placements.every(({ source }) => source === first.source);
  return {
    label: oneSource && first.source ? sourceName(first.source) : t('ownKey'),
    icon: 'KeyRound',
  };
}

/** A provider model's display name ("GPT Transcribe"), else its id. */
export function modelLabel(source: string, task: SheetTask, modelId: string | undefined): string {
  if (!modelId) return '';
  const scope = task === 'meeting' ? 'dictation' : task;
  const models = getMobileProvidersForScope(scope).find((item) => item.id === source)?.models;
  const found = models?.find((model) => model.id === modelId);
  if (found) return found.name;
  // A live model is named after its batch sibling ("AssemblyAI STT 3.7 Realtime").
  const batch = models?.find((model) => `${model.id}-realtime` === modelId);
  return batch ? `${batch.name} Realtime` : modelId;
}

// --- Snapshots, for Undo -------------------------------------------------------------------

type Snapshot = {
  config: Partial<
    Pick<UserConfig, 'inference' | 'rememberedInference' | 'pinnedInference' | 'defaultMode'>
  >;
  defaults: ProcessingDefault;
  activeMode: ProcessingMode;
};

function snapshot(): Snapshot {
  const config = useConfigStore.getState().config;
  return {
    config: {
      inference: config?.inference,
      rememberedInference: config?.rememberedInference,
      pinnedInference: config?.pinnedInference,
      defaultMode: config?.defaultMode,
    },
    defaults: { ...useProcessingDefault.getState() },
    activeMode: useProcessingModeStore.getState().activeMode,
  };
}

async function restore(saved: Snapshot): Promise<void> {
  markDefault(saved.defaults);
  await useConfigStore.getState().updateConfig(saved.config as Partial<UserConfig>);
  useProcessingModeStore.getState().setActiveMode(saved.activeMode, true);
}

// --- Custom server -------------------------------------------------------------------------

const SERVER_KEY = 'android-fable-custom-server';
type CustomServer = { endpoint?: string; speechModels?: string[]; textModels?: string[] };
function readServer(): CustomServer {
  try {
    return JSON.parse(localStorage.getItem(SERVER_KEY) ?? '{}') as CustomServer;
  } catch {
    return {};
  }
}
/** The one custom server this phone knows, with the models it listed when it was checked. */
export const useCustomServer = create<CustomServer>(() => readServer());
function rememberServer(server: CustomServer) {
  useCustomServer.setState(server, true);
  try {
    if (server.endpoint) localStorage.setItem(SERVER_KEY, JSON.stringify(server));
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    // Kept for this run only.
  }
}

/** "http://192.168.1.4:11434" with a scheme added when it was left off. */
export function normalizeServer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

const SPEECH_MODEL = /whisper|transcri|parakeet|speech|asr|stt|canary|moonshine|voxtral|nova/i;
/** A server's models, split into the ones that transcribe and the ones that write text. */
export function splitModels(models: string[]): { speech: string[]; text: string[] } {
  return {
    speech: models.filter((model) => SPEECH_MODEL.test(model)),
    text: models.filter((model) => !SPEECH_MODEL.test(model) && !/embed/i.test(model)),
  };
}

export type ServerCheck = KeyCheckResult & {
  speech?: string[];
  text?: string[];
  /** The base that answered: a bare address may resolve to its /v1 API. */
  endpoint?: string;
  /** Not an address this phone can use (https, or http on a local network). */
  invalidAddress?: boolean;
};

/**
 * Lists the server's models, which any OpenAI-compatible server answers at /models (copied from
 * the v1 test build): an answer is a working server and key, 401/403 a refused key, anything
 * else an address that couldn't be reached.
 */
export async function checkCustomServer(endpoint: string, apiKey?: string): Promise<ServerCheck> {
  try {
    const key = apiKey?.trim() || undefined;
    // The shared discovery only sends a typed key for a route that names where it'd be stored.
    const credentialRef = key
      ? await getProviderCredentialReference('custom', endpoint)
      : undefined;
    const found = await discoverProviderModels({
      route: {
        mode: 'providers',
        scope: 'cleanup',
        providerId: 'custom',
        modelId: 'check',
        endpoint,
        ...(credentialRef ? { credentialRef } : {}),
      },
      apiKey: key,
    });
    const { speech, text } = splitModels(found.models.map((model) => model.id));
    return { state: 'connected', speech, text, endpoint: found.endpoint ?? endpoint };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'INVALID_CREDENTIAL') return { state: 'failed', reason: 'rejected' };
    if (
      code === 'ENDPOINT_INVALID' ||
      code === 'PROVIDER_HTTPS_REQUIRED' ||
      (error as Error).message === 'Invalid provider endpoint'
    )
      return { state: 'failed', reason: 'status', invalidAddress: true };
    return { state: 'failed', reason: 'network' };
  }
}

/** Checks a server half a second after the address or key last changed; `run` checks at once. */
export function useServerCheck(endpoint: string, apiKey: string) {
  const [result, setResult] = useState<(ServerCheck & { for: string }) | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const address = normalizeServer(endpoint);
  useEffect(() => {
    const mine = ++revision.current;
    setResult(null);
    setChecking(false);
    if (!address) return;
    const timer = setTimeout(
      () => {
        setChecking(true);
        void checkCustomServer(address, apiKey).then((next) => {
          if (revision.current !== mine) return;
          setChecking(false);
          setResult({ ...next, for: `${address}|${apiKey}` });
        });
      },
      attempt ? 0 : KEY_CHECK_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [address, apiKey, attempt]);
  // An answer only counts for the address and key it was for: typing never reads as checked.
  const current = result?.for === `${address}|${apiKey}` ? result : null;
  return {
    state: current ? current.state : checking ? ('checking' as const) : ('idle' as const),
    result: current,
    run: () => setAttempt((count) => count + 1),
  };
}

async function serverKey(endpoint: string): Promise<string> {
  const credential = await getProviderCredential(
    await getProviderCredentialReference('custom', endpoint),
  ).catch(() => null);
  return credential?.apiKey ?? '';
}

async function saveCustomServer(server: CustomServer, apiKey: string): Promise<void> {
  const previous = useCustomServer.getState().endpoint;
  if (previous && previous !== server.endpoint)
    await removeProviderCredential(await getProviderCredentialReference('custom', previous)).catch(
      () => undefined,
    );
  if (apiKey.trim())
    await setProviderCredential(await getProviderCredentialReference('custom', server.endpoint), {
      apiKey: apiKey.trim(),
    });
  rememberServer(server);
}

async function customSelection(modelId: string): Promise<InferenceSelection> {
  const { endpoint } = useCustomServer.getState();
  if (!endpoint) throw new Error('No custom server saved');
  const reference = await getProviderCredentialReference('custom', endpoint);
  const status = await getProviderCredentialStatus(reference).catch(() => null);
  return {
    mode: 'providers',
    providerId: 'custom',
    modelId,
    endpoint,
    ...(status?.isConfigured ? { credentialRef: reference } : {}),
  };
}

/** The models a source offers for a task, for the task sheet's model list. */
export function sourceModels(source: Source, task: SheetTask): string[] {
  if (task === 'meeting') return isLiveProvider(source) ? [LIVE_MODEL[source]] : [];
  if (source === 'custom') {
    const server = useCustomServer.getState();
    return (
      (task === 'dictation' || task === 'upload' ? server.speechModels : server.textModels) ?? []
    );
  }
  return providerModels(source, task);
}

// --- Saved keys ----------------------------------------------------------------------------

export type SavedSource = { source: Source; tail: string };

/** The saved keys (and the custom server), each with its last four characters, kept current. */
// The last read, so the key card shows at once when Processing opens again (the reads take a
// moment: each key is decrypted).
let lastSources: SavedSource[] | null = null;

export function useSavedSources(): SavedSource[] | null {
  const [saved, setSaved] = useState<SavedSource[] | null>(lastSources);
  const server = useCustomServer((s) => s.endpoint);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const keys = await Promise.all(
        KEY_PROVIDERS.map(async ({ id }) => {
          const key = await savedKey(id).catch(() => null);
          return key ? { source: id as Source, tail: key.trim().slice(-4) } : null;
        }),
      );
      // A custom server counts as saved even with no key: some servers take none.
      const custom = server
        ? { source: 'custom' as Source, tail: (await serverKey(server)).slice(-4) }
        : null;
      lastSources = [...keys, custom].filter((item): item is SavedSource => !!item);
      if (live) setSaved(lastSources);
    };
    void read();
    const unsubscribe = subscribeProviderCredentialChanges(() => void read());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [server]);
  return saved;
}

/** The saved key of a source ('' for a custom server that takes none). */
export async function readSourceKey(source: Source): Promise<string> {
  if (source === 'custom') {
    const { endpoint } = useCustomServer.getState();
    return endpoint ? serverKey(endpoint) : '';
  }
  return (await savedKey(source).catch(() => null)) ?? '';
}

// --- Moving tasks --------------------------------------------------------------------------

/** One task onto a saved key, on the given model or the source's starting one. */
export async function runOnSource(source: Source, task: SheetTask, modelId?: string) {
  if (source === 'custom') {
    const server = useCustomServer.getState();
    const models =
      task === 'dictation' || task === 'upload' ? server.speechModels : server.textModels;
    const model = modelId ?? models?.[0];
    if (!model) return;
    await setTask(task, await customSelection(model));
    return;
  }
  await runTaskOnKey(source, task, modelId);
}

/** Every task a key's source can run moves onto it. */
async function everythingOnSource(source: Source): Promise<SheetTask[]> {
  const tasks = sourceTasks(source);
  if (source === 'custom') {
    for (const task of tasks) await runOnSource('custom', task);
    markDefault({ mode: 'providers', providerId: 'custom' as KeyProviderId });
  } else await applyDefault({ mode: 'providers', providerId: source });
  return tasks;
}

/** "Use for everything" on Cloud: every task moves there. Returns the Undo. */
export async function everythingOnCloud(): Promise<() => Promise<void>> {
  const saved = snapshot();
  await applyDefault({ mode: 'openwhispr' });
  return () => restore(saved);
}

// --- On device, with downloads -------------------------------------------------------------

/**
 * `meeting`: the Meeting recording model, a speech model that can transcribe meetings, apart
 * from dictation's. Meeting speakers downloads by itself (liveSpeakers/speakerModel.ts).
 */
export type PhoneKind = 'speech' | 'text' | 'meeting';
export function kindOf(task: SheetTask): PhoneKind {
  if (task === 'meeting') return 'meeting';
  return task === 'dictation' || task === 'upload' ? 'speech' : 'text';
}
export function phoneModelOf(config: UserConfig | null, kind: PhoneKind): AndroidModelId {
  if (kind === 'speech') return config?.androidSpeechModel ?? 'parakeet-v3';
  if (kind === 'text') return config?.androidTextModel ?? 'qwen-balanced';
  // The dictation model when it can do meetings, else the catalog's first meeting model.
  const dictation = config?.androidSpeechModel ?? 'parakeet-v3';
  return canTranscribeMeetings(dictation)
    ? dictation
    : (meetingModelRows()[0]?.id ?? 'parakeet-v3');
}

type Job = { id: AndroidModelId; tasks: SheetTask[] };
/**
 * Models downloading for tasks waiting to move on device, one at a time. Each task moves as its
 * model lands; until then it stays where it was (D2).
 */
export const usePhoneQueue = create<{ jobs: Job[]; doneBytes: number; totalBytes: number }>(() => ({
  jobs: [],
  doneBytes: 0,
  totalBytes: 0,
}));
let running = false;
/** Set by "Use for everything" on device: once every model has landed, it says so, with Undo. */
let finishedUndo: (() => Promise<void>) | null = null;

async function moveOnDevice(tasks: SheetTask[]) {
  for (const task of tasks) await setTask(task, { mode: 'local' });
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = usePhoneQueue.getState().jobs[0];
      if (!job) break;
      let landed = false;
      try {
        // Another screen may already be downloading it: wait for that one instead.
        if (useModelDownloads.getState().progress[job.id] !== undefined)
          await new Promise<void>((resolve) => {
            const unsubscribe = useModelDownloads.subscribe((state) => {
              if (state.progress[job.id] === undefined) {
                unsubscribe();
                resolve();
              }
            });
          });
        else await downloadAndroidModel(job.id);
        landed = await modelReady(job.id).catch(() => false);
      } catch (error) {
        if ((error as Error).message !== i18n.t('downloadCancelled'))
          Alert.alert(settingsT('downloadProblem'), (error as Error).message, [
            { text: settingsT('ok') },
          ]);
        else {
          // Cancelled: the unfinished model's files go too, so no space is held for it.
          await removeAndroidModel(job.id).catch(() => undefined);
          // Cancelled from its ring (the queue still holds it): say so. Cancel and Undo say it
          // themselves, or need not.
          if (usePhoneQueue.getState().jobs[0]?.id === job.id)
            showToast(settingsT('downloadCancelled'), 'neutral');
        }
      }
      // The job may have been cancelled (Undo) while it downloaded.
      const current = usePhoneQueue.getState().jobs[0];
      if (!current || current.id !== job.id) continue;
      if (landed) await moveOnDevice(current.tasks).catch(() => undefined);
      usePhoneQueue.setState((state) => ({
        jobs: state.jobs.slice(1),
        doneBytes: state.doneBytes + ANDROID_MODELS[job.id].bytes,
      }));
    }
  } finally {
    running = false;
    usePhoneQueue.setState({ jobs: [], doneBytes: 0, totalBytes: 0 });
    const undo = finishedUndo;
    finishedUndo = null;
    // D3: everything is on the phone now (a failed or cancelled download leaves no toast).
    const config = useConfigStore.getState().config;
    if (undo && SHEET_TASKS.every((task) => config?.inference?.[task]?.mode === 'local'))
      showToast(fableT('everythingDevice'), 'success', {
        label: settingsT('undo'),
        onPress: () => void undo().catch(() => undefined),
        onClose: () => undefined,
      });
  }
}

/**
 * Moves tasks on device: the ones whose model is on the phone move now, the rest queue their
 * model's download and move when it lands. A task already queued is queued once.
 */
export async function moveTasksOnDevice(tasks: SheetTask[]): Promise<void> {
  const config = useConfigStore.getState().config;
  const now: SheetTask[] = [];
  const later = new Map<AndroidModelId, SheetTask[]>();
  for (const task of tasks) {
    const id = phoneModelOf(config, kindOf(task));
    if (await modelReady(id).catch(() => false)) now.push(task);
    else later.set(id, [...(later.get(id) ?? []), task]);
  }
  await moveOnDevice(now);
  if (!later.size) return;
  usePhoneQueue.setState((state) => {
    const jobs = [...state.jobs];
    let added = 0;
    for (const [id, waiting] of later) {
      const existing = jobs.find((job) => job.id === id);
      if (existing) existing.tasks = [...new Set([...existing.tasks, ...waiting])];
      else {
        jobs.push({ id, tasks: waiting });
        added += ANDROID_MODELS[id].bytes;
      }
    }
    return { jobs, totalBytes: state.totalBytes + added };
  });
  void runQueue();
}

/** A task picked somewhere else stops waiting for its model (the download carries on). */
export function stopWaiting(task: SheetTask) {
  usePhoneQueue.setState((state) => ({
    jobs: state.jobs.map((job) => ({ ...job, tasks: job.tasks.filter((item) => item !== task) })),
  }));
}

/** Undo for a move on device: queued tasks stop waiting, and the download in flight stops. */
function cancelQueue() {
  const first = usePhoneQueue.getState().jobs[0];
  usePhoneQueue.setState({ jobs: [], doneBytes: 0, totalBytes: 0 });
  if (first) void cancelAndroidDownload(first.id);
}

/**
 * Cancel on the On device card's progress line: every queued download stops and its files
 * go. Models that landed stay, tasks that moved stay on device, and tasks still waiting stay
 * where they were.
 */
export function cancelPhoneDownloads() {
  finishedUndo = null;
  cancelQueue();
}

/** The models "Use for everything" on device still has to download (D1). */
export async function missingForEverything(): Promise<AndroidModelId[]> {
  const config = useConfigStore.getState().config;
  const ids = [
    ...new Set((['speech', 'text', 'meeting'] as const).map((kind) => phoneModelOf(config, kind))),
  ];
  const ready = await Promise.all(ids.map((id) => modelReady(id).catch(() => false)));
  return ids.filter((_, index) => !ready[index]);
}

/** "Use for everything" on device. Returns the Undo. */
export async function everythingOnDevice(): Promise<() => Promise<void>> {
  const saved = snapshot();
  markDefault({ mode: 'local' });
  const undo = async () => {
    finishedUndo = null;
    cancelQueue();
    await restore(saved);
  };
  finishedUndo = undo;
  await moveTasksOnDevice([...SHEET_TASKS]);
  // Nothing had to download: the queue never ran, so nothing else will say it's done.
  if (!usePhoneQueue.getState().jobs.length) finishedUndo = null;
  return undo;
}

// --- Adding and removing keys --------------------------------------------------------------

/**
 * Saves a checked key (or custom server) and, when asked, runs every task it can on it. Returns
 * the tasks it now runs and the Undo, which puts back the key it replaced, if any.
 */
export async function addSource(
  source: Source,
  apiKey: string,
  useForAll: boolean,
  server?: { endpoint: string; speech: string[]; text: string[] },
): Promise<{ tasks: SheetTask[]; undo: () => Promise<void> }> {
  const saved = snapshot();
  const previousServer = { ...useCustomServer.getState() };
  const previousKey = await readSourceKey(source);
  if (source === 'custom' && server)
    await saveCustomServer(
      { endpoint: server.endpoint, speechModels: server.speech, textModels: server.text },
      apiKey,
    );
  else await saveKey(source as KeyProviderId, apiKey);
  const tasks = useForAll ? await everythingOnSource(source) : [];
  return {
    tasks,
    undo: async () => {
      if (source === 'custom') {
        const endpoint = useCustomServer.getState().endpoint;
        if (endpoint)
          await removeProviderCredential(
            await getProviderCredentialReference('custom', endpoint),
          ).catch(() => undefined);
        if (previousServer.endpoint) await saveCustomServer(previousServer, previousKey);
        else rememberServer({});
      } else if (previousKey) await saveKey(source as KeyProviderId, previousKey);
      else await removeProviderCredential(await getProviderCredentialReference(source));
      await restore(saved);
    },
  };
}

/** Replaces a saved key with a new one that passed its check; its tasks stay on it. */
export async function changeSourceKey(source: Source, apiKey: string): Promise<void> {
  if (source === 'custom') {
    const server = useCustomServer.getState();
    await saveCustomServer(server, apiKey);
    return;
  }
  await saveKey(source, apiKey);
}

/** The tasks a source runs now, in task order. */
export function tasksOn(
  source: Source,
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): SheetTask[] {
  return SHEET_TASKS.filter((task) => {
    const placement = placementOf(config, task, activeMode, cloudAccess);
    return placement.place === 'key' && placement.source === source;
  });
}

/**
 * Removes a key. Its tasks move to Cloud, or On device when signed out (7D). Returns the Undo,
 * which saves the key again and puts every task back.
 */
export async function removeSource(
  source: Source,
  signedIn: boolean,
  cloudAccess: CloudAccess,
): Promise<() => Promise<void>> {
  const saved = snapshot();
  const server = { ...useCustomServer.getState() };
  const key = await readSourceKey(source);
  const config = useConfigStore.getState().config;
  const tasks = tasksOn(source, config, useProcessingModeStore.getState().activeMode, cloudAccess);
  if (signedIn) for (const task of tasks) await setTask(task, { mode: 'openwhispr' });
  else await moveTasksOnDevice(tasks);
  if (useProcessingDefault.getState().providerId === source)
    markDefault({ mode: signedIn ? 'openwhispr' : 'local' });
  if (source === 'custom') {
    if (server.endpoint)
      await removeProviderCredential(
        await getProviderCredentialReference('custom', server.endpoint),
      ).catch(() => undefined);
    rememberServer({});
  } else await removeProviderCredential(await getProviderCredentialReference(source));
  return async () => {
    if (source === 'custom') await saveCustomServer(server, key);
    else if (key) await saveKey(source, key);
    await restore(saved);
  };
}
