import { create } from 'zustand';
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
export function insightsScope(): string {
  const user = useAuthStore.getState().user;
  return user && !user.isAnonymous ? `account:${user.id}` : 'device';
}
function read(scope: string): Ledger {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope)) ?? 'null') as Ledger | null;
    if (value && Array.isArray(value.events) && Array.isArray(value.acknowledged)) return value;
  } catch {
    /* An unreadable ledger must not prevent dictation. */
  }
  return empty();
}
function write(scope: string, ledger: Ledger) {
  if (localStorage.getItem(`${key(scope)}:deleted`)) return;
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
    if (active) trailing = true;
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
  localStorage.setItem(`${key(scope)}:deleted`, 'true');
  localStorage.removeItem(key(scope));
  if (useInsights.getState().scope === scope)
    useInsights.setState({ ledger: empty(), status: 'idle' });
}
let trailing = false;
let active: Promise<void> | null = null;
export function refreshInsights(): Promise<void> {
  const scope = insightsScope();
  const continuing = active && useInsights.getState().scope === scope;
  useInsights.setState({
    scope,
    ledger: read(scope),
    status: continuing ? 'loading' : 'idle',
    consentPaused: isConsentPaused(),
  });
  if (!canSync(scope)) return Promise.resolve();
  if (active) return active;
  const run = async () => {
    useInsights.setState({ status: 'loading' });
    try {
      const ledger = read(scope);
      const ack = new Set(ledger.acknowledged);
      const pending = ledger.events.filter((event) => !ack.has(event.event_id));
      for (let offset = 0; offset < pending.length; offset += 200) {
        if (!canSync(scope)) return;
        const batch = pending.slice(offset, offset + 200);
        const response = await api.post<{ accepted: string[]; rejected: string[] }>(
          '/api/analytics/events/batch',
          { events: batch },
          { headers: { 'x-openwhispr-source': 'mobile' } },
        );
        if (!canSync(scope)) return;
        if (!Array.isArray(response.accepted) || !Array.isArray(response.rejected))
          throw new Error('Invalid analytics acknowledgement');
        const ids = new Set(batch.map((event) => event.event_id));
        [...response.accepted, ...response.rejected]
          .filter((id) => ids.has(id))
          .forEach((id) => ack.add(id));
        write(scope, { ...read(scope), acknowledged: [...ack] });
      }
      if (!canSync(scope)) return;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const response = await api.get<Summary>(
        `/api/analytics/summary?timeZone=${encodeURIComponent(timeZone)}`,
        { headers: { 'x-openwhispr-source': 'mobile' } },
      );
      if (!canSync(scope)) return;
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
      if (insightsScope() === scope)
        useInsights.setState({
          status:
            error instanceof ApiError && error.code === 'POLICY_CLOUD_BACKUP_BLOCKED'
              ? 'blocked'
              : 'offline',
        });
    } finally {
      active = null;
      if (!canSync(scope) && useInsights.getState().scope === scope)
        useInsights.setState({ status: 'idle' });
      if (insightsScope() !== scope || trailing) {
        trailing = false;
        void refreshInsights();
      }
    }
  };
  active = run();
  return active;
}
