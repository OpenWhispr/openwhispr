import { useEffect, useRef, useState } from 'react';

/** What a key check comes back with, named after desktop's ConnectionStatusIcon states. */
export type KeyCheckState = 'idle' | 'checking' | 'connected' | 'failed' | 'unverified';
export type KeyCheckReason = 'rejected' | 'status' | 'managementKey' | 'timeout' | 'network';
export type KeyCheckResult = {
  state: 'connected' | 'failed' | 'unverified';
  reason?: KeyCheckReason;
  status?: number;
};

/** Half a second after the last change, as on desktop (useConnectionAutoCheck). */
export const KEY_CHECK_DELAY_MS = 500;
/** Desktop's probe timeout; no answer by then is "couldn't check", never a refusal. */
export const KEY_CHECK_TIMEOUT_MS = 12000;

export type KeyProviderId = 'openai' | 'groq' | 'deepgram' | 'assemblyai' | 'openrouter';

/** One read-only request per provider, the same ones desktop's key check makes. */
const PROBES: Record<KeyProviderId, string> = {
  openai: 'https://api.openai.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  deepgram: 'https://api.deepgram.com/v1/auth/token',
  assemblyai: 'https://api.assemblyai.com/v2/transcript?limit=1',
  openrouter: 'https://openrouter.ai/api/v1/key',
};

/** Deepgram takes "Token <key>" and AssemblyAI the bare key; the rest are bearer tokens. */
function authorization(provider: KeyProviderId, apiKey: string): string {
  if (provider === 'deepgram') return `Token ${apiKey}`;
  if (provider === 'assemblyai') return apiKey;
  return `Bearer ${apiKey}`;
}

/** Desktop's describeStatusFailure: 401/403 refuse the key; 408, 429 and 5xx give no verdict. */
export function classifyStatus(status: number): KeyCheckResult {
  if (status >= 200 && status < 300) return { state: 'connected' };
  if (status === 401 || status === 403) return { state: 'failed', reason: 'rejected', status };
  if (status === 408 || status === 429 || status >= 500)
    return { state: 'unverified', reason: 'status', status };
  return { state: 'failed', reason: 'status', status };
}

export async function checkProviderKey(
  provider: KeyProviderId,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<KeyCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEY_CHECK_TIMEOUT_MS);
  try {
    const request = (url: string) =>
      fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: authorization(provider, apiKey) },
        signal: controller.signal,
      });
    let response = await request(PROBES[provider]);
    // A Deepgram project without the token endpoint is checked against its projects instead.
    if (provider === 'deepgram' && response.status === 404)
      response = await request('https://api.deepgram.com/v1/projects');
    const result = classifyStatus(response.status);
    // An OpenRouter management key can't run models, so it is refused like a wrong key.
    if (result.state === 'connected' && provider === 'openrouter') {
      const body = (await response.json().catch(() => null)) as {
        data?: { is_management_key?: boolean; is_provisioning_key?: boolean };
      } | null;
      if (body?.data?.is_management_key || body?.data?.is_provisioning_key)
        return { state: 'failed', reason: 'managementKey' };
    }
    return result;
  } catch {
    return {
      state: 'unverified',
      reason: controller.signal.aborted ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks a typed key on its own: half a second after the last change, with an answer for an
 * older key dropped. `retry` checks the same key again at once.
 */
export function useKeyCheck(
  provider: KeyProviderId,
  apiKey: string,
  check: typeof checkProviderKey = checkProviderKey,
): { state: KeyCheckState; result: KeyCheckResult | null; retry: () => void } {
  const [result, setResult] = useState<KeyCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const checked = useRef('');
  const key = apiKey.trim();

  useEffect(() => {
    const mine = ++revision.current;
    setResult(null);
    setChecking(false);
    if (!key) return;
    // Nothing shows for the first half second, in case more of the key is still coming. A retry
    // of the same key doesn't wait.
    const same = checked.current === `${provider}:${key}`;
    checked.current = `${provider}:${key}`;
    const timer = setTimeout(
      () => {
        setChecking(true);
        void check(provider, key).then((next) => {
          if (revision.current !== mine) return;
          setChecking(false);
          setResult(next);
        });
      },
      same ? 0 : KEY_CHECK_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [provider, key, attempt, check]);

  return {
    state: result ? result.state : checking ? 'checking' : 'idle',
    result,
    retry: () => setAttempt((count) => count + 1),
  };
}
