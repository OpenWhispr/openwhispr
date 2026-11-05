import { create } from 'zustand';
import { z } from 'zod';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';

export interface InsightEvent {
  event_id: string;
  occurred_at: string;
  local_date: string;
  word_count: number;
  spoken_duration_ms: number | null;
  mode: 'local' | 'openwhispr_cloud' | 'byok';
  provider: string | null;
  model: string | null;
  counter_version: 2;
}
interface Summary {
  totalWords: number;
  totalDictations: number;
}
interface Ledger {
  events: InsightEvent[];
  acknowledged: string[];
  summary?: Summary;
}
const empty = (): Ledger => ({ events: [], acknowledged: [] });
const key = (scope: string) => `android-insights-v1:${scope}`;
const eventSchema = z
  .object({
    event_id: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }),
    local_date: z.string().date(),
    word_count: z.number().int().positive(),
    spoken_duration_ms: z.number().int().nonnegative().nullable(),
    mode: z.enum(['local', 'openwhispr_cloud', 'byok']),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    counter_version: z.literal(2),
  })
  .strict();
const summarySchema = z.object({
  totalWords: z.number().int().nonnegative(),
  totalDictations: z.number().int().nonnegative(),
});

function parseLedger(raw: string | null): { ledger: Ledger; damaged: boolean } {
  if (raw === null) return { ledger: empty(), damaged: false };
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored))
      return { ledger: empty(), damaged: true };
    const value = stored as Record<string, unknown>;
    const ledger = empty();
    const ids = new Set<string>();
    let damaged = !Array.isArray(value.events) || !Array.isArray(value.acknowledged);
    for (const item of Array.isArray(value.events) ? value.events : []) {
      const parsed = eventSchema.safeParse(item);
      if (!parsed.success || ids.has(parsed.data.event_id)) {
        damaged = true;
        continue;
      }
      ids.add(parsed.data.event_id);
      ledger.events.push(parsed.data);
    }
    for (const id of Array.isArray(value.acknowledged) ? value.acknowledged : []) {
      if (typeof id === 'string' && id) ledger.acknowledged.push(id);
      else damaged = true;
    }
    if (value.summary !== undefined) {
      const summary = summarySchema.safeParse(value.summary);
      if (summary.success) ledger.summary = summary.data;
      else damaged = true;
    }
    return { ledger, damaged };
  } catch {
    return { ledger: empty(), damaged: true };
  }
}

export function insightsScope(): string {
  const user = useAuthStore.getState().user;
  return user && !user.isAnonymous ? `account:${user.id}` : 'device';
}
function read(scope: string): Ledger {
  try {
    return parseLedger(localStorage.getItem(key(scope))).ledger;
  } catch {
    /* An unreadable ledger must not prevent dictation. */
  }
  return empty();
}
function write(scope: string, ledger: Ledger) {
  if (localStorage.getItem(`${key(scope)}:deleted`)) return;
  const raw = localStorage.getItem(key(scope));
  // Keep the damaged bytes before repair; a failed backup must not overwrite them.
  if (raw !== null && parseLedger(raw).damaged) localStorage.setItem(`${key(scope)}:recovery`, raw);
  localStorage.setItem(key(scope), JSON.stringify(ledger));
  if (insightsScope() === scope) useInsights.setState({ scope, ledger });
}
export function countSpokenWords(text: string): number {
  const fallback = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (
    !fallback ||
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
  )
    return fallback;
  try {
    if (typeof Intl.Segmenter !== 'function') return fallback;
    const segments = new Intl.Segmenter('und', { granularity: 'word' }).segment(text);
    return Array.from(segments).filter((part) => part.isWordLike).length || fallback;
  } catch {
    return fallback;
  }
}
export function recordInsight(scope: string, event: InsightEvent) {
  if (
    localStorage.getItem(`${key(scope)}:deleted`) ||
    useConfigStore.getState().config?.androidHistoryDays === 0 ||
    !event.word_count
  )
    return;
  const ledger = read(scope);
  if (ledger.events.some((item) => item.event_id === event.event_id)) return;
  write(scope, { ...ledger, events: [...ledger.events, event] });
  if (canSync(scope)) {
    if (active && isCurrent(active)) active.trailing = true;
    else void refreshInsights();
  }
}
export const useInsights = create<{
  scope: string;
  ledger: Ledger;
  status: 'idle' | 'loading' | 'offline' | 'blocked';
  consentPaused: boolean;
}>(() => ({ scope: '', ledger: empty(), status: 'idle', consentPaused: false }));
let syncDenied = false;
let consentRevision = 0;
function isConsentPaused() {
  if (syncDenied) return true;
  try {
    return Boolean(localStorage.getItem('android-insights-opt-out'));
  } catch {
    return true;
  }
}
function canSync(scope: string) {
  if (isConsentPaused()) return false;
  const config = useConfigStore.getState().config;
  try {
    return (
      !localStorage.getItem(`${key(scope)}:deleted`) &&
      insightsScope() === scope &&
      scope.startsWith('account:') &&
      config?.insightsSyncEnabled === true &&
      config.androidHistoryDays !== 0
    );
  } catch {
    // Unreadable consent storage cannot authorize an upload.
    return false;
  }
}
export async function setInsightsSyncConsent(enabled: boolean): Promise<void> {
  // Stop immediately, even if the very first disk write fails. Only a fully
  // persisted, explicit opt-in may lift this process-local block.
  const revision = ++consentRevision;
  syncDenied = true;
  cancelActive();
  useInsights.setState({ consentPaused: true });
  if (!enabled) localStorage.setItem('android-insights-opt-out', 'true');
  await useConfigStore.getState().updateConfig({ insightsSyncEnabled: enabled });
  const state = useConfigStore.getState();
  if (state.error || state.config?.insightsSyncEnabled !== enabled)
    throw new Error(state.error || 'Unable to save Insights preference.');
  if (revision !== consentRevision) return;
  if (enabled) {
    localStorage.removeItem('android-insights-opt-out');
    syncDenied = false;
    useInsights.setState({ consentPaused: false });
  }
  // Network latency must not prevent a subsequent opt-out in Settings.
  void refreshInsights();
}
export function eraseAccountInsights(userId: string): void {
  const scope = `account:${userId}`;
  if (active?.scope === scope) cancelActive();
  localStorage.setItem(`${key(scope)}:deleted`, 'true');
  localStorage.removeItem(key(scope));
  localStorage.removeItem(`${key(scope)}:recovery`);
  if (useInsights.getState().scope === scope)
    useInsights.setState({ ledger: empty(), status: 'idle' });
}
interface SyncRun {
  scope: string;
  sessionCookie: string | null;
  consentRevision: number;
  controller: AbortController;
  promise: Promise<void>;
  trailing: boolean;
  dispose: () => void;
}
let active: SyncRun | null = null;

function isCurrent(run: SyncRun): boolean {
  return (
    active === run &&
    !run.controller.signal.aborted &&
    run.consentRevision === consentRevision &&
    useAuthStore.getState().sessionCookie === run.sessionCookie &&
    canSync(run.scope)
  );
}

function cancelActive(): void {
  const run = active;
  if (!run) return;
  // A new run need not wait for a transport that is slow to settle after abort.
  // The old run can no longer acknowledge events or clear its replacement.
  active = null;
  run.dispose();
  run.controller.abort();
  if (useInsights.getState().scope === run.scope) useInsights.setState({ status: 'idle' });
}

export function refreshInsights(): Promise<void> {
  const scope = insightsScope();
  if (active && !isCurrent(active)) cancelActive();
  const continuing = active?.scope === scope;
  useInsights.setState({
    scope,
    ledger: read(scope),
    status: continuing ? 'loading' : 'idle',
    consentPaused: isConsentPaused(),
  });
  if (!canSync(scope)) return Promise.resolve();
  if (active) return active.promise;
  const run: SyncRun = {
    scope,
    sessionCookie: useAuthStore.getState().sessionCookie,
    consentRevision,
    controller: new AbortController(),
    promise: Promise.resolve(),
    trailing: false,
    dispose: () => undefined,
  };
  active = run;
  // Observe identity and consent while a request is waiting, even if Home is not
  // focused. Once invalidated, an A→B→A or OFF→ON transition cannot revive a run.
  const cancelIfInvalid = () => {
    if (active !== run || isCurrent(run)) return;
    cancelActive();
    refreshInsights().catch(() => undefined);
  };
  const unsubscribeAuth = useAuthStore.subscribe(cancelIfInvalid);
  const unsubscribeConfig = useConfigStore.subscribe(cancelIfInvalid);
  run.dispose = () => {
    unsubscribeAuth();
    unsubscribeConfig();
  };
  const requestOptions = {
    headers: { 'x-openwhispr-source': 'mobile' },
    signal: run.controller.signal,
  };
  const boundedRequest = async <T>(request: Promise<T>): Promise<T> => {
    const { signal } = run.controller;
    let rejectAborted = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(new Error('Statistics request interrupted.'));
      signal.addEventListener('abort', rejectAborted, { once: true });
      if (signal.aborted) rejectAborted();
    });
    const timer = setTimeout(() => {
      if (isCurrent(run)) useInsights.setState({ status: 'offline' });
      run.controller.abort();
    }, 30_000);
    try {
      // Some transports settle slowly after abort. Release the run now so retry
      // can proceed, and never publish the old request's eventual response.
      return await Promise.race([request, aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAborted);
    }
  };
  const sync = async () => {
    useInsights.setState({ status: 'loading' });
    try {
      const ledger = read(scope);
      const ack = new Set(ledger.acknowledged);
      const pending = ledger.events.filter((event) => !ack.has(event.event_id));
      for (let offset = 0; offset < pending.length; offset += 200) {
        if (!isCurrent(run)) return;
        const batch = pending.slice(offset, offset + 200);
        const response = await boundedRequest(
          api.post<{ accepted: string[]; rejected: string[] }>(
            '/api/analytics/events/batch',
            { events: batch },
            requestOptions,
          ),
        );
        if (!isCurrent(run)) return;
        if (!Array.isArray(response.accepted) || !Array.isArray(response.rejected))
          throw new Error('Invalid analytics acknowledgement');
        const ids = new Set(batch.map((event) => event.event_id));
        [...response.accepted, ...response.rejected]
          .filter((id) => ids.has(id))
          .forEach((id) => ack.add(id));
        write(scope, { ...read(scope), acknowledged: [...ack] });
      }
      if (!isCurrent(run)) return;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const response = await boundedRequest(
        api.get<Summary>(
          `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`,
          requestOptions,
        ),
      );
      if (!isCurrent(run)) return;
      if (
        ![response.totalWords, response.totalDictations].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new Error('Invalid analytics summary');
      write(scope, {
        ...read(scope),
        summary: { totalWords: response.totalWords, totalDictations: response.totalDictations },
      });
      useInsights.setState({ status: 'idle' });
    } catch (error) {
      if (isCurrent(run))
        useInsights.setState({
          status:
            error instanceof ApiError && error.code === 'POLICY_CLOUD_BACKUP_BLOCKED'
              ? 'blocked'
              : 'offline',
        });
    } finally {
      run.dispose();
      if (active === run) {
        active = null;
        if (!canSync(scope) && useInsights.getState().scope === scope)
          useInsights.setState({ status: 'idle' });
        if (insightsScope() !== scope || run.trailing) void refreshInsights();
      }
    }
  };
  run.promise = sync();
  return run.promise;
}
