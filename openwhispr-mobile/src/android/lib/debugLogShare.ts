import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Sharing from 'expo-sharing';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { flushDebugLog } from './debugLog';
import { buildDebugLogHeader, type DebugLogSnapshot, type ScopeLine } from './debugLogHeader';
import { requiresRealAccount } from './accountAccess';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useConfigStore } from '@/android/store/useConfigStore';
import { useUsageStore } from '@/android/store/useUsageStore';
import { ANDROID_MODELS, modelReady, type AndroidModelId } from '@/android/models';

// The scopes the header names, in the order a tester thinks of them.
const SCOPES: [label: string, scope: string][] = [
  ['dictation', 'dictation'],
  ['cleanup', 'cleanup'],
  ['assistant', 'agent'],
  ['meetings', 'meeting'],
  ['upload', 'upload'],
  ['notes', 'notes'],
  ['note_chat', 'noteChat'],
];

export async function collectDebugLogSnapshot(now = new Date()): Promise<DebugLogSnapshot> {
  const info = AndroidDictation?.getDebugInfo?.();
  const config = useConfigStore.getState().config;
  const usage = useUsageStore.getState().usage;
  const inference = (config?.inference ?? {}) as Record<string, ScopeLine | undefined>;
  const extra = Constants.expoConfig?.extra?.openWhispr as { appEnvironment?: string } | undefined;
  const scopes: ScopeLine[] = SCOPES.map(([label, scope]) => {
    const selection = inference[scope] as { mode?: string; providerId?: string; modelId?: string } | undefined;
    return { scope: label, mode: selection?.mode ?? 'default', provider: selection?.providerId, model: selection?.modelId };
  });
  if (config?.androidTranslationTarget?.code)
    scopes.push({ scope: 'translation', mode: `into ${config.androidTranslationTarget.code}` });
  const models: { id: string; ready: boolean }[] = [];
  for (const id of Object.keys(ANDROID_MODELS) as AndroidModelId[]) {
    const ready = await modelReady(id).catch(() => false);
    if (ready) models.push({ id, ready });
  }
  return {
    generatedAt: now,
    app: {
      version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '?',
      build: Application.nativeBuildVersion ?? '?',
      packageName: Application.applicationId ?? '?',
      environment: extra?.appEnvironment ?? 'unknown',
      // apiClient's BASE_URL, read the same way without loading the API client.
      apiBaseUrl: process.env.EXPO_PUBLIC_API_URL || 'https://api.openwhispr.com',
    },
    device: {
      manufacturer: info?.manufacturer ?? '?',
      model: info?.model ?? '?',
      release: info?.release ?? '?',
      sdk: info?.sdk ?? 0,
    },
    batteryOptimizationIgnored: info ? info.ignoringBatteryOptimizations : null,
    permissions: {
      microphone: !!info?.microphone,
      overlay: !!info?.overlay,
      accessibility: !!info?.accessibility,
      notifications: !!info?.notifications,
    },
    account: {
      signedIn: !requiresRealAccount(useAuthStore.getState().user),
      plan: usage ? `${usage.plan}${usage.isTrial ? ' (trial)' : ''}` : null,
      workspaceIds: usage?.entitlementSources?.workspaceIds ?? [],
    },
    defaultMode: config?.defaultMode ?? null,
    scopes,
    models,
    services: { bubble: !!info?.bubbleRunning, meeting: !!info?.meetingRunning },
    debugLogging: {
      on: !!info?.enabled,
      since: info?.enabledSince ?? 0,
      onAtLaunch: !!info?.onAtLaunch,
      processAgeMs: info?.processAgeMs ?? 0,
    },
    microphone: { owner: info?.micOwner ?? null, module: info?.micModule ?? null, heldMs: info?.micHeldMs ?? null },
  };
}

/** Builds the file (header + log) and opens the share sheet. Nothing is ever sent on its own. */
export async function shareDebugLog(): Promise<void> {
  if (!AndroidDictation?.exportDebugLog) throw new Error('Debug log unavailable');
  flushDebugLog();
  const header = buildDebugLogHeader(await collectDebugLogSnapshot());
  const uri = await AndroidDictation.exportDebugLog(header);
  await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: 'OpenWhispr debug log' });
}

export async function hasDebugLog(): Promise<boolean> {
  flushDebugLog();
  return (await AndroidDictation?.hasDebugLog?.().catch(() => false)) ?? false;
}

export async function clearDebugLog(): Promise<void> {
  await AndroidDictation?.clearDebugLog?.();
}
