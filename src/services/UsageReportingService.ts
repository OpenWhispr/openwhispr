import { cloudPost } from "./cloudApi.js";

export type UsageFeature = "dictation" | "meeting" | "upload";
export type UsageMode = "cloud" | "byok" | "local";

export interface UsageReport {
  feature: UsageFeature;
  mode: UsageMode;
  wordCount: number;
  audioDurationMs?: number;
  clientEventId: string;
}

interface QueuedUsageEvent extends UsageReport {
  occurredAt: string;
}

interface AnalyticsGate {
  managed: boolean;
  collectLocalUsage: boolean;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const QUEUE_KEY = "usageEvents.queue";
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
// How long the stt-config gate flags are trusted before a re-fetch — an admin
// flipping collectLocalUsage takes effect on the next fetch, no restart needed.
const GATE_TTL_MS = 5 * 60 * 1000;
const MAX_QUEUE_LENGTH = 500;
// Web Lock serializing every queue mutation across windows (the queue lives in
// shared localStorage).
const QUEUE_LOCK = "openwhispr-usage-events-queue";

class UsageReportingService {
  private started = false;
  private gate: { value: AnalyticsGate; fetchedAt: number } | null = null;
  private gateFetch: Promise<AnalyticsGate | null> | null = null;

  // Events are queued only for signed-in users. When a gate is known (fresh
  // fetch, or the last-known value as a fallback) denied events are dropped
  // before anything is persisted. When the gate cannot be fetched at all
  // (offline), the event is queued and gating is deferred to flush(), which
  // never sends without an authoritative gate — so usage never transits the
  // network against the admin's collectLocalUsage setting.
  async report(event: UsageReport): Promise<void> {
    try {
      if (event.wordCount <= 0 || !this.isSignedIn()) return;
      const gate = (await this.getGate()) ?? this.gate?.value ?? null;
      if (gate && !this.isEventAllowed(event, gate)) return;
      await this.enqueue({ ...event, occurredAt: new Date().toISOString() });
      void this.flush();
    } catch (err) {
      console.error("Usage report failed:", err);
    }
  }

  // Whether identified workspace usage reporting can be active for this user
  // (member of a managed workspace) — drives the Settings privacy disclosure.
  async isWorkspaceReportingActive(): Promise<boolean> {
    return (await this.getGate())?.managed === true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.flush();
    setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  async flush(): Promise<void> {
    if (!this.isSignedIn() || this.readQueue().length === 0) return;
    try {
      await navigator.locks.request(QUEUE_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        // Sends require an authoritative gate. If it cannot be fetched, leave
        // the queue intact and retry later — events are only dropped when the
        // gate explicitly denies them (admin turned collection off).
        const gate = await this.getGate();
        if (!gate) return;
        const queue = this.readQueue();
        const allowed = queue.filter((event) => this.isEventAllowed(event, gate));
        if (allowed.length !== queue.length) this.writeQueue(allowed);
        while (true) {
          const batch = this.readQueue().slice(0, FLUSH_BATCH_SIZE);
          if (batch.length === 0) return;
          await cloudPost("/api/usage-events", { events: batch });
          // Surgical removal: re-read and drop only the sent ids so events
          // enqueued while the batch was in flight survive.
          const sent = new Set(batch.map((event) => event.clientEventId));
          this.writeQueue(this.readQueue().filter((event) => !sent.has(event.clientEventId)));
        }
      });
    } catch (err) {
      console.error("Usage flush failed:", err);
    }
  }

  private isSignedIn(): boolean {
    return localStorage.getItem("isSignedIn") === "true";
  }

  private isEventAllowed(event: Pick<UsageReport, "feature">, gate: AnalyticsGate | null): boolean {
    if (!this.isSignedIn() || !gate?.managed) return false;
    // Meeting usage is core service metering the server never sees and
    // bypasses the local-collection opt-in.
    return event.feature === "meeting" || gate.collectLocalUsage;
  }

  private async getGate(): Promise<AnalyticsGate | null> {
    if (!this.isSignedIn()) return null;
    if (this.gate && Date.now() - this.gate.fetchedAt < GATE_TTL_MS) return this.gate.value;
    if (this.gateFetch) return this.gateFetch;
    this.gateFetch = (async () => {
      try {
        const config = await window.electronAPI.getSttConfig?.();
        if (!config?.success) return null;
        const value = {
          managed: config.managed === true,
          collectLocalUsage: config.collectLocalUsage === true,
        };
        this.gate = { value, fetchedAt: Date.now() };
        return value;
      } catch (err) {
        console.error("Usage gate fetch failed:", err);
        return null;
      } finally {
        this.gateFetch = null;
      }
    })();
    return this.gateFetch;
  }

  private readQueue(): QueuedUsageEvent[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeQueue(events: QueuedUsageEvent[]): void {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(events));
  }

  private enqueue(event: QueuedUsageEvent): Promise<void> {
    return navigator.locks.request(QUEUE_LOCK, async () => {
      const queue = this.readQueue();
      if (queue.some((queued) => queued.clientEventId === event.clientEventId)) return;
      queue.push(event);
      this.writeQueue(queue.slice(-MAX_QUEUE_LENGTH));
    });
  }
}

export const usageReportingService = new UsageReportingService();
