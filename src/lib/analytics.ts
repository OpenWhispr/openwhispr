/**
 * Analytics shim.
 *
 * All calls are no-ops by default. The previous OpenWhispr-cloud telemetry
 * pipeline has been removed. This module exists so a real provider
 * (PostHog is the planned target) can be wired in here without touching
 * every call site:
 *
 *   import posthog from "posthog-js";
 *   posthog.init(import.meta.env.VITE_POSTHOG_KEY, { api_host: ... });
 *
 *   adapter = {
 *     track:    (e, p)  => posthog.capture(e, p),
 *     identify: (id, p) => posthog.identify(id, p),
 *     reset:    ()      => posthog.reset(),
 *   };
 *
 * Until that happens, the `enabled` flag (driven by the privacy toggle in
 * Settings) controls whether events would be forwarded. Calls always succeed
 * — failures inside the provider must never break the app.
 */

import logger from "../utils/logger";

export type AnalyticsProperties = Record<string, unknown>;

export interface AnalyticsAdapter {
  track(event: string, properties?: AnalyticsProperties): void;
  identify(userId: string, traits?: AnalyticsProperties): void;
  reset(): void;
}

const noopAdapter: AnalyticsAdapter = {
  track: () => {},
  identify: () => {},
  reset: () => {},
};

let adapter: AnalyticsAdapter = noopAdapter;
let enabled = false;

function safeRun(fn: () => void) {
  try {
    fn();
  } catch (err) {
    logger.debug("analytics adapter threw", { error: (err as Error)?.message }, "analytics");
  }
}

export const analytics = {
  /** Replace the underlying provider. Pass `null` to revert to no-op. */
  setAdapter(next: AnalyticsAdapter | null) {
    adapter = next ?? noopAdapter;
  },

  /** Driven by the "telemetryEnabled" setting in Privacy. */
  setEnabled(value: boolean) {
    enabled = value;
  },

  isEnabled(): boolean {
    return enabled;
  },

  track(event: string, properties?: AnalyticsProperties) {
    if (!enabled) return;
    safeRun(() => adapter.track(event, properties));
  },

  identify(userId: string, traits?: AnalyticsProperties) {
    if (!enabled) return;
    safeRun(() => adapter.identify(userId, traits));
  },

  reset() {
    safeRun(() => adapter.reset());
  },
};

export default analytics;
