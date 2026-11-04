const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Dashboard funnel milestones this build can report. Sent with every upload as
// coverage, which is what tells a stage nobody could observe apart from one
// that never happened.
const CAPABILITIES = ["app_session_authenticated", "onboarding_completed"];
const SCHEMA_VERSION = 1;
const BATCH_SIZE = 50;
// The queue only ever holds a handful of milestones; these bound what a server
// that never acknowledges (deferring an event forever, or unreachable) leaves behind.
const MAX_QUEUED_EVENTS = 200;
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const ONBOARDING_SETUP_MODES = new Set(["cloud", "byok", "local", "managed"]);
const STATE_VERSION = 1;

const OS_BY_PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" };

function emptyState() {
  return { version: STATE_VERSION, installationId: null, onboardingCompletions: 0, events: [] };
}

/**
 * A JSON file written by write-then-rename, so a crash mid-write never leaves
 * a truncated queue. An unreadable file starts a fresh queue: losing an
 * unsent milestone reads as unobserved, never as a wrong fact.
 */
function createFileStore(file, fsImpl = fs) {
  return {
    load() {
      try {
        const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.events)) return emptyState();
        return { ...emptyState(), ...parsed };
      } catch {
        return emptyState();
      }
    },
    save(state) {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      fsImpl.renameSync(temp, file);
    },
  };
}

function sameScope(a, b) {
  return Boolean(a && b && a.accountId === b.accountId && a.authGeneration === b.authGeneration);
}

/**
 * The desktop side of the product-events ledger (/api/product-events/batch).
 * Content-free milestones only: never text, audio, titles or app context.
 *
 * Every event is queued for the account whose validated scope it was captured
 * under, and only ever uploaded inside that account's scope, fenced to the
 * credential generation the upload started with: an account switch can delay
 * an event, never move it to the other account. A signed-out (guest) action
 * has no identity to report under and is not recorded.
 */
class ProductEvents {
  constructor({
    store,
    getScope,
    request,
    platform = process.platform,
    getAppVersion = () => null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = null,
  }) {
    this.store = store;
    this.getScope = getScope;
    this.request = request;
    this.os = OS_BY_PLATFORM[platform] ?? "unknown";
    this.getAppVersion = getAppVersion;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.state = store.load();
    this.running = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    // Per process run: the scopes whose session was bound, and whose coverage
    // was reported, so neither repeats on every reconciliation.
    this.boundScopes = new Set();
    this.reportedScopes = new Set();
    // Scopes whose organization refused cloud records; left alone until the
    // scope changes or the app restarts.
    this.blockedScopes = new Set();
  }

  persist(update) {
    const next = update(structuredClone(this.state));
    this.store.save(next);
    this.state = next;
  }

  installationId() {
    if (!this.state.installationId) {
      this.persist((state) => ({ ...state, installationId: randomUUID() }));
    }
    return this.state.installationId;
  }

  enqueue(event) {
    this.persist((state) => {
      if (state.events.some((queued) => queued.event_id === event.event_id)) return state;
      // Oldest first out when full: a newer milestone is worth more than one
      // the server has been refusing to take.
      const events = [...state.events, event].slice(-MAX_QUEUED_EVENTS);
      return { ...state, events };
    });
  }

  scopeKey(scope) {
    return `${scope.accountId}:${scope.authGeneration}`;
  }

  /**
   * The renderer has validated and committed this account's session. Binds it
   * on the server, which records when it first validated this session on this
   * installation, and queues app_session_authenticated under that binding. A
   * session that could not be validated (offline, expired) never reaches here.
   */
  async recordAppSession(context) {
    const scope = this.getScope();
    if (!sameScope(scope, context) || this.boundScopes.has(this.scopeKey(scope))) return;
    this.boundScopes.add(this.scopeKey(scope));
    let result;
    try {
      result = await this.request({
        path: "/api/product-events/app-session",
        method: "POST",
        body: {
          surface: "desktop",
          os: this.os,
          installation_id: this.installationId(),
          app_version: this.getAppVersion(),
        },
        expectedAuthGeneration: scope.authGeneration,
      });
    } catch (error) {
      result = { success: false, error: error?.message };
    }
    const bindingId = result?.data?.binding_id;
    const authenticatedAt = result?.data?.authenticated_at;
    if (!result?.success || typeof bindingId !== "string" || typeof authenticatedAt !== "string") {
      // Refused (policy, anonymous, unbindable) or not answered: the sign-in
      // stays unobserved rather than taking a client time. A transport
      // failure may bind on the next validation of this scope.
      if (!result?.status || result.status >= 500) this.boundScopes.delete(this.scopeKey(scope));
      return;
    }
    if (!sameScope(this.getScope(), scope)) return;
    this.enqueue({
      // One binding is one event: retries and relaunches resend the same id.
      event_id: bindingId,
      event_name: "app_session_authenticated",
      occurred_at: authenticatedAt,
      account_id: scope.accountId,
      identity_generation: scope.authGeneration,
      app_version: this.getAppVersion(),
      flow_version: null,
      properties: { binding_id: bindingId },
      captured_at: new Date(this.now()).toISOString(),
    });
    await this.flush();
  }

  /** The final onboarding completion was persisted (AppRouter's handleOnboardingComplete). */
  recordOnboardingCompleted({ setupMode = null, flowVersion = null } = {}) {
    const scope = this.getScope();
    const replay = this.state.onboardingCompletions > 0;
    this.persist((state) => ({ ...state, onboardingCompletions: state.onboardingCompletions + 1 }));
    if (!scope) return;
    const occurredAt = new Date(this.now()).toISOString();
    this.enqueue({
      event_id: randomUUID(),
      event_name: "onboarding_completed",
      occurred_at: occurredAt,
      account_id: scope.accountId,
      identity_generation: scope.authGeneration,
      app_version: this.getAppVersion(),
      flow_version: typeof flowVersion === "string" && flowVersion ? flowVersion : null,
      properties: ONBOARDING_SETUP_MODES.has(setupMode)
        ? { replay, setup_mode: setupMode }
        : { replay },
      captured_at: occurredAt,
    });
    void this.flush();
  }

  /** Drops what an erased account left queued here. */
  purge(accountId) {
    this.persist((state) => ({
      ...state,
      events: state.events.filter((event) => event.account_id !== accountId),
    }));
  }

  async flush() {
    if (this.running) return this.running;
    this.running = this.runPass()
      .catch((error) => {
        this.logger?.debug?.("Product events upload failed", { error: error?.message });
        this.scheduleRetry();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    this.retryTimer?.unref?.();
  }

  // An event the server keeps deferring (an API that never learns it) or an
  // account that never signs in again would otherwise stay queued for good.
  dropExpired() {
    const cutoff = this.now() - MAX_EVENT_AGE_MS;
    const fresh = (event) => !(Date.parse(event.captured_at) < cutoff);
    if (this.state.events.every(fresh)) return;
    this.persist((state) => ({ ...state, events: state.events.filter(fresh) }));
  }

  async runPass() {
    const scope = this.getScope();
    if (!scope) return;
    const key = this.scopeKey(scope);
    if (this.blockedScopes.has(key)) return;
    this.dropExpired();

    // Another account's events wait for that account's own scope.
    const pending = this.state.events
      .filter((event) => event.account_id === scope.accountId)
      .slice(0, BATCH_SIZE);
    if (pending.length === 0 && this.reportedScopes.has(key)) return;

    const result = await this.request({
      path: "/api/product-events/batch",
      method: "POST",
      body: {
        collector: {
          surface: "desktop",
          os: this.os,
          installation_id: this.installationId(),
          app_version: this.getAppVersion(),
          capabilities: CAPABILITIES,
          sent_at: new Date(this.now()).toISOString(),
        },
        events: pending.map((event) => ({
          event_id: event.event_id,
          event_name: event.event_name,
          schema_version: SCHEMA_VERSION,
          occurred_at: event.occurred_at,
          app_version: event.app_version,
          flow_version: event.flow_version,
          identity_generation: event.identity_generation,
          properties: event.properties,
        })),
      },
      expectedAuthGeneration: scope.authGeneration,
    });
    // The request handler fences the credential; the scope must still name
    // the same account, or the answer belongs to a session that is gone.
    if (!sameScope(this.getScope(), scope)) return;

    if (result?.status === 403 && result.code === "POLICY_CLOUD_BACKUP_BLOCKED") {
      // The organization keeps this account unobserved. What it queued is
      // not collected later either.
      this.blockedScopes.add(key);
      const sent = new Set(pending.map((event) => event.event_id));
      this.persist((state) => ({
        ...state,
        events: state.events.filter((event) => !sent.has(event.event_id)),
      }));
      return;
    }
    // A dead session waits for the next credential, whose scope flushes again.
    if (result?.status === 401) return;
    // Includes 503 PRODUCT_EVENTS_RETRY, sent when an identity link completed mid-upload.
    if (!result?.success) throw new Error(result?.error || "Product events upload unavailable");

    this.retryAttempt = 0;
    this.reportedScopes.add(key);
    // Only accepted ids leave the queue. Deferred ones (an older API that
    // doesn't know the event yet) and any id the answer leaves out stay,
    // until accepted or too old, and go again with the next upload.
    const accepted = new Set(
      (Array.isArray(result.data?.accepted) ? result.data.accepted : []).map((id) =>
        String(id).toLowerCase()
      )
    );
    if (accepted.size > 0) {
      this.persist((state) => ({
        ...state,
        events: state.events.filter((event) => !accepted.has(event.event_id.toLowerCase())),
      }));
    }
    // A full batch taken whole may have more behind it.
    if (pending.length === BATCH_SIZE && accepted.size === pending.length) await this.runPass();
  }

  dispose() {
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}

module.exports = { CAPABILITIES, ProductEvents, createFileStore };
