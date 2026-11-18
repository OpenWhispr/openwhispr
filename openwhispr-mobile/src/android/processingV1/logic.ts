import { useEffect, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { create } from 'zustand';
import type { InferenceSelection } from '@/lib/mobileProviders';
import { providerDisplayName } from '@/lib/mobileProviders';
import {
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import { discoverProviderModels } from '@/services/providers/ProviderExecution';
import type { UserConfig } from '@/types';
import { meetingKey } from '../providers/liveMeeting';
import { KEY_CHECK_DELAY_MS, type KeyCheckResult, type KeyProviderId } from '../settings/keyCheck';
import {
  KEY_PROVIDERS,
  SHEET_TASKS,
  providerCanRun,
  runTaskOnKey,
  type SheetTask,
} from '../settings/ownKey';
import { applyDefault, markDefault, setTask } from '../settings/processingDefault';
import { modelName } from '../settings/modelCatalog';
import { phoneModelFor } from '../settings/processingTasks';
import type { V1T } from './strings';

/**
 * Processing v1 (test build): the original Settings tree, with the lessons learned since. Every
 * task still runs its own engine (processingDefault.ts); this file adds what v1 needs on top:
 * a custom server that works end to end, and the "key used by" summaries.
 */

/** A source of keys on v1's pickers: the five providers, then a custom server. */
export type KeySource = KeyProviderId | 'custom';
export const KEY_SOURCES: { id: KeySource; name: string; keyUrl?: string }[] = [
  ...KEY_PROVIDERS,
  { id: 'custom', name: 'Custom server' },
];
export const sourceName = (id: string) =>
  id === 'custom' ? 'Custom server' : (KEY_PROVIDERS.find((p) => p.id === id)?.name ?? id);

/** Custom server tasks: any OpenAI-compatible server transcribes and writes text, never live. */
export function sourceCanRun(source: string, task: SheetTask): boolean {
  if (source === 'custom') return task !== 'meeting';
  return providerCanRun(source, task);
}

// --- Custom server -------------------------------------------------------------------------

const SERVER_KEY = 'android-v1-custom-server';
type CustomServer = { endpoint?: string };
function readServer(): CustomServer {
  try {
    return JSON.parse(localStorage.getItem(SERVER_KEY) ?? '{}') as CustomServer;
  } catch {
    return {};
  }
}
/** The one custom server this phone knows; its key is stored under its address. */
export const useCustomServer = create<CustomServer>(() => readServer());
export function rememberServer(endpoint: string | undefined) {
  useCustomServer.setState({ endpoint }, true);
  try {
    if (endpoint) localStorage.setItem(SERVER_KEY, JSON.stringify({ endpoint }));
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

export type ServerCheck = KeyCheckResult & {
  models?: string[];
  /** The base that answered: a bare address may resolve to its /v1 API. */
  endpoint?: string;
  message?: string;
  /** Not an address this phone can use (https, or http on a local network). */
  invalidAddress?: boolean;
};

/**
 * Lists the server's models, which any OpenAI-compatible server answers at /models: an answer
 * is a working server (and key), a 401/403 a refused key, anything else no verdict.
 */
export async function checkCustomServer(endpoint: string, apiKey?: string): Promise<ServerCheck> {
  try {
    const key = apiKey?.trim() || undefined;
    // A key is only sent for a route that names where it would be stored; the typed key stands
    // in for the stored one while it is checked.
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
    return { state: 'connected', models: found.models.map((m) => m.id), endpoint: found.endpoint };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'INVALID_CREDENTIAL') return { state: 'failed', reason: 'rejected' };
    if (
      code === 'ENDPOINT_INVALID' ||
      code === 'PROVIDER_HTTPS_REQUIRED' ||
      (error as Error).message === 'Invalid provider endpoint'
    )
      return { state: 'failed', reason: 'status', invalidAddress: true };
    return { state: 'unverified', reason: 'network', message: (error as Error).message };
  }
}

/** Checks a server address (and optional key) half a second after the last change. */
export function useServerCheck(endpoint: string, apiKey: string) {
  const [result, setResult] = useState<ServerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const address = normalizeServer(endpoint);
  useEffect(() => {
    const mine = ++revision.current;
    setResult(null);
    setChecking(false);
    if (!address) return;
    const timer = setTimeout(() => {
      setChecking(true);
      void checkCustomServer(address, apiKey).then((next) => {
        if (revision.current !== mine) return;
        setChecking(false);
        setResult(next);
      });
    }, KEY_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [address, apiKey, attempt]);
  return {
    state: result ? result.state : checking ? ('checking' as const) : ('idle' as const),
    result,
    retry: () => setAttempt((count) => count + 1),
  };
}

export async function customServerKey(endpoint: string): Promise<string | null> {
  try {
    const credential = await getProviderCredential(
      await getProviderCredentialReference('custom', endpoint),
    );
    return credential?.apiKey ?? null;
  } catch {
    return null;
  }
}

/** Saves the server, and its key when one was given (a server may need none). */
export async function saveCustomServer(endpoint: string, apiKey: string): Promise<void> {
  const previous = useCustomServer.getState().endpoint;
  if (previous && previous !== endpoint)
    await removeProviderCredential(await getProviderCredentialReference('custom', previous)).catch(
      () => undefined,
    );
  if (apiKey.trim())
    await setProviderCredential(await getProviderCredentialReference('custom', endpoint), {
      apiKey: apiKey.trim(),
    });
  rememberServer(endpoint);
}

export async function customSelection(endpoint: string, modelId: string) {
  const reference = await getProviderCredentialReference('custom', endpoint);
  const status = await getProviderCredentialStatus(reference).catch(() => null);
  const selection: InferenceSelection = {
    mode: 'providers',
    providerId: 'custom',
    modelId,
    endpoint,
    ...(status?.isConfigured ? { credentialRef: reference } : {}),
  };
  return selection;
}

// --- Keys ----------------------------------------------------------------------------------

/** The saved keys' last four characters, kept current as keys come and go. */
export function useKeyTails(): Partial<Record<KeySource, string>> {
  const [tails, setTails] = useState<Partial<Record<KeySource, string>>>({});
  const server = useCustomServer((s) => s.endpoint);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const entries = await Promise.all(
        KEY_PROVIDERS.map(async ({ id }) => {
          const credential = await getProviderCredential(
            await getProviderCredentialReference(id),
          ).catch(() => null);
          return [id, credential?.apiKey?.slice(-4)] as const;
        }),
      );
      // A custom server counts as saved even with no key: some servers take none.
      const custom = server ? ((await customServerKey(server))?.slice(-4) ?? '') : undefined;
      if (live)
        setTails(
          Object.fromEntries(
            [...entries, ['custom', custom] as const].filter(([, tail]) => tail !== undefined),
          ),
        );
    };
    void read();
    const unsubscribe = subscribeProviderCredentialChanges(() => void read());
    return () => {
      live = false;
      unsubscribe();
    };
  }, [server]);
  return tails;
}

/**
 * The saved key for a provider (or the custom server's key, '' when it takes none), read again
 * whenever the screen comes back and whenever a key is added or removed. `null` until read.
 */
export function useSavedSecret(source: string, server?: string): string | null {
  const [secret, setSecret] = useState<string | null>(null);
  const focused = useIsFocused();
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeProviderCredentialChanges(() => setRevision((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    if (!source) {
      setSecret(null);
      return;
    }
    const read =
      source === 'custom'
        ? server
          ? customServerKey(server).then((key) => key ?? '')
          : Promise.resolve(null)
        : getProviderCredentialReference(source)
            .then(getProviderCredential)
            .then((credential) => credential?.apiKey ?? null)
            .catch(() => null);
    void read.then((key) => live && setSecret(key));
    return () => {
      live = false;
    };
  }, [source, server, focused, revision]);
  return secret;
}

export async function removeKey(source: KeySource): Promise<void> {
  if (source === 'custom') {
    const endpoint = useCustomServer.getState().endpoint;
    if (endpoint)
      await removeProviderCredential(
        await getProviderCredentialReference('custom', endpoint),
      ).catch(() => undefined);
    rememberServer(undefined);
    return;
  }
  await removeProviderCredential(await getProviderCredentialReference(source));
}

/** The tasks a key runs right now, in task order. */
export function tasksUsing(config: UserConfig | null, source: KeySource): SheetTask[] {
  return SHEET_TASKS.filter((task) => {
    if (task === 'meeting') return meetingKey()?.providerId === source;
    const selection = config?.inference?.[task];
    return selection?.mode === 'providers' && selection.providerId === source;
  });
}

export const TASK_KEY = {
  dictation: 'dictation',
  upload: 'audioUploads',
  cleanup: 'textCleanup',
  notes: 'noteFormatting',
  meeting: 'meetings',
} as const;

/** "Dictation and Text cleanup", "Dictation, Audio uploads and Meetings". */
export function taskList(t: V1T, tasks: SheetTask[]): string {
  const names = tasks.map((task) => t(TASK_KEY[task]));
  if (names.length <= 1) return names[0] ?? '';
  return t('listAnd', { first: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

/** A task's value on Customize each task: Cloud, On device, or the key it runs on. */
export function taskValue(t: V1T, config: UserConfig | null, task: SheetTask): string {
  if (task === 'cleanup' && !(config?.cleanupEnabled ?? true)) return t('offInSettings');
  if (task === 'meeting') {
    const key = meetingKey();
    if (key) return t('keyValue', { provider: sourceName(key.providerId) });
    return t(config?.inference?.meeting?.mode === 'local' ? 'thisPhone' : 'cloudShort');
  }
  const selection = config?.inference?.[task];
  if (selection?.mode === 'local') return t('thisPhone');
  if (selection?.mode === 'providers' && selection.providerId)
    return t('keyValue', { provider: sourceName(selection.providerId) });
  return t('cloudShort');
}

/** "On device · Parakeet v3" for a task page's row. */
export function phoneLine(config: UserConfig | null, task: Exclude<SheetTask, 'meeting'>) {
  return modelName(phoneModelFor(config, task));
}

// --- Applying the Default ------------------------------------------------------------------

/**
 * Your own key as the Default: every task the provider can run moves onto it, and the model
 * chosen on Processing goes to the tasks it fits (speech to dictation and uploads, text to
 * cleanup and notes).
 */
export async function applyKeyDefault(provider: KeyProviderId, model: string): Promise<void> {
  await applyDefault({ mode: 'providers', providerId: provider });
  const speech = providerCanRun(provider, 'dictation');
  const tasks: SheetTask[] = speech ? ['dictation', 'upload'] : ['cleanup', 'notes'];
  if (model) for (const task of tasks) await runTaskOnKey(provider, task, model);
}

/**
 * A custom server as the Default. A server's model can be a speech model or a text model, so
 * each kind has its own ID; a kind left blank keeps its tasks where they are.
 */
export async function applyCustomDefault(
  endpoint: string,
  speechModel: string,
  textModel: string,
): Promise<void> {
  const tasks: [Exclude<SheetTask, 'meeting'>, string][] = [
    ['dictation', speechModel],
    ['upload', speechModel],
    ['cleanup', textModel],
    ['notes', textModel],
  ];
  for (const [task, model] of tasks) {
    if (!model.trim()) continue;
    await setTask(task, await customSelection(endpoint, model.trim()));
  }
  markDefault({ mode: 'providers', providerId: 'custom' as KeyProviderId });
}

export { providerDisplayName };
