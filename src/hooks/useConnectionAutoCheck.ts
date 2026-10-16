import { useCallback, useEffect, useRef, useState } from "react";
import { useDelayedFlag } from "./useDelayedFlag";

type TestProviderConnection = NonNullable<Window["electronAPI"]["testProviderConnection"]>;
export type ProviderConnectionConfig = Parameters<TestProviderConnection>[0];
export type ProviderConnectionResult = Awaited<ReturnType<TestProviderConnection>>;
/** "waiting": the pause runs and nothing is sent; "checking": a request is out. */
type ConnectionCheckPhase = "idle" | "waiting" | "checking" | "connected" | "failed";

export interface ConnectionAutoCheck {
  phase: ConnectionCheckPhase;
  /** The answer while phase is "failed". */
  failure: ProviderConnectionResult | null;
  /** Re-sends the current entry at once. */
  retry: () => void;
  /** For one polite live region. */
  announcement: "testing" | "connected" | null;
}

/** The quiet time after the last change before the request is sent; a paste is one change. */
export const CONNECTION_CHECK_DELAY_MS = 500;
/**
 * "Testing…" is announced only for a request still out after this long, so quick answers
 * don't chatter.
 */
const CONNECTION_CHECK_ANNOUNCE_DELAY_MS = 1000;

interface ConnectionAutoCheckOptions {
  config: ProviderConnectionConfig;
  /** Every required field is filled. */
  ready: boolean;
  /** Send nothing yet, e.g. while an address is still being typed. */
  hold?: boolean;
  /** Defaults to CONNECTION_CHECK_DELAY_MS; 0 checks at once. */
  delayMs?: number;
}

/**
 * Checks a provider connection by itself, once `config` has gone `delayMs` without a change.
 * Every change starts over, and an answer for an earlier entry is never shown.
 */
export function useConnectionAutoCheck({
  config,
  ready,
  hold = false,
  delayMs = CONNECTION_CHECK_DELAY_MS,
}: ConnectionAutoCheckOptions): ConnectionAutoCheck {
  // Any change, even one back to an earlier value or one that empties a field, starts a new
  // revision. An answer is shown only for the revision it was sent for.
  const configKey = JSON.stringify(config);
  const [tracked, setTracked] = useState({ configKey, ready, revision: 0 });
  if (tracked.configKey !== configKey || tracked.ready !== ready) {
    setTracked({ configKey, ready, revision: tracked.revision + 1 });
  }
  const { revision } = tracked;
  const [inFlight, setInFlight] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<{
    revision: number;
    result: ProviderConnectionResult;
  } | null>(null);
  const latest = useRef({ config, revision });
  useEffect(() => {
    latest.current = { config, revision };
  });

  const send = useCallback(async (sentRevision: number) => {
    setOutcome(null);
    setInFlight(sentRevision);
    let result: ProviderConnectionResult;
    try {
      result = (await window.electronAPI?.testProviderConnection?.(latest.current.config)) ?? {
        success: false,
      };
    } catch {
      result = { success: false };
    }
    if (sentRevision !== latest.current.revision) return;
    setOutcome({ revision: sentRevision, result });
    setInFlight(null);
  }, []);

  const settled = outcome?.revision === revision ? outcome.result : null;
  const phase: ConnectionCheckPhase = !ready
    ? "idle"
    : settled
      ? settled.success
        ? "connected"
        : "failed"
      : inFlight === revision
        ? "checking"
        : hold
          ? "idle"
          : "waiting";

  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setTimeout(() => void send(revision), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, phase, revision, send]);

  const retry = useCallback(() => void send(latest.current.revision), [send]);
  const slow = useDelayedFlag(phase === "checking", CONNECTION_CHECK_ANNOUNCE_DELAY_MS);

  return {
    phase,
    failure: phase === "failed" ? settled : null,
    retry,
    announcement:
      phase === "connected" ? "connected" : phase === "checking" && slow ? "testing" : null,
  };
}
