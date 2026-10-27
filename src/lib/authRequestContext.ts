import { clearOfflineAccountProfile, writeOfflineAccountProfile } from "./offlineAccountProfile";
import { isControlPanelWindow } from "../utils/windowContext";

const AUTH_REQUEST_GENERATION = "openWhisprAuthGeneration";

export interface AuthTokenState {
  token: string | null;
  generation: number;
}

export interface AuthTokenStateEvent {
  generation: number;
  hasToken: boolean;
}

export interface OfflineAccount {
  userId: string;
  generation: number;
}

export interface RendererAuthContextSnapshot {
  revision: number;
  observedGeneration: number | null;
  hasToken: boolean;
  sessionResolved: boolean;
  sessionGeneration: number | null;
  sessionUserId: string | null;
  validatedGeneration: number | null;
  /**
   * The account main's token-bound binding names while get-session for this
   * generation has no answer (offline, server down). Presentation only: it
   * never validates the generation, so sync and cloud API calls stay fenced.
   */
  offlineAccount: OfflineAccount | null;
  /** A generation get-session rejected (401) or resolved to no user: never presented offline. */
  sessionRejectedGeneration: number | null;
  /**
   * The bound generation whose session refetch then failed. The binding keeps
   * presenting the account, but only a new answer from the server may
   * validate it again.
   */
  refetchFailedGeneration: number | null;
}

type AuthRequest = {
  url?: URL | string;
  headers?: Headers | Record<string, string>;
  credentials?: RequestCredentials;
  [AUTH_REQUEST_GENERATION]?: number;
};

type AuthErrorContext = {
  request: AuthRequest;
  response?: Response;
};

type AuthSuccessContext = {
  data?: unknown;
  response: Response;
  request: AuthRequest;
};

const EMPTY_SNAPSHOT: Omit<RendererAuthContextSnapshot, "revision"> = {
  observedGeneration: null,
  hasToken: false,
  sessionResolved: false,
  sessionGeneration: null,
  sessionUserId: null,
  validatedGeneration: null,
  offlineAccount: null,
  sessionRejectedGeneration: null,
  refetchFailedGeneration: null,
};

let snapshot: RendererAuthContextSnapshot = { ...EMPTY_SNAPSHOT, revision: 0 };
// When the server last answered get-session. Kept out of the snapshot: every
// answer changes it, and subscribers only care about the session it resolved.
let sessionAnsweredAt: number | null = null;
const subscribers = new Set<() => void>();

function publish(next: Omit<RendererAuthContextSnapshot, "revision">): void {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  subscribers.forEach((subscriber) => subscriber());
}

function update(
  updater: (current: RendererAuthContextSnapshot) => Omit<RendererAuthContextSnapshot, "revision">
): void {
  const next = updater(snapshot);
  const comparableCurrent = { ...snapshot, revision: 0 };
  const comparableNext = { ...next, revision: 0 };
  if (JSON.stringify(comparableCurrent) === JSON.stringify(comparableNext)) return;
  publish(next);
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function observeState(generation: number, hasToken: boolean): void {
  if (!validGeneration(generation)) return;
  update((current) => {
    const generationChanged = current.observedGeneration !== generation;
    const dropSession = generationChanged && current.sessionGeneration !== generation;
    const dropValidated = generationChanged && current.validatedGeneration !== generation;
    return {
      ...current,
      observedGeneration: generation,
      hasToken,
      sessionResolved: dropSession ? false : current.sessionResolved,
      sessionGeneration: dropSession ? null : current.sessionGeneration,
      sessionUserId: dropSession ? null : current.sessionUserId,
      validatedGeneration: dropValidated ? null : current.validatedGeneration,
      offlineAccount:
        current.offlineAccount?.generation === generation && hasToken
          ? current.offlineAccount
          : null,
      sessionRejectedGeneration: generationChanged ? null : current.sessionRejectedGeneration,
      refetchFailedGeneration: generationChanged ? null : current.refetchFailedGeneration,
    };
  });
}

export function observeAuthTokenState(state: AuthTokenState): void {
  observeState(state.generation, Boolean(state.token));
}

export function observeAuthTokenStateEvent(state: AuthTokenStateEvent): void {
  observeState(state.generation, state.hasToken);
}

export function subscribeAuthRequestContext(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

export function getAuthRequestContextSnapshot(): RendererAuthContextSnapshot {
  return snapshot;
}

export function getAuthRequestContextServerSnapshot(): RendererAuthContextSnapshot {
  return snapshot;
}

export async function readAuthTokenState(): Promise<AuthTokenState> {
  const state = await window.electronAPI?.authGetTokenState?.();
  if (!state || !validGeneration(state.generation)) {
    throw Object.assign(new Error("Authentication token state is unavailable"), {
      code: "AUTH_CONTEXT_UNVALIDATED",
    });
  }
  const normalized = {
    token: typeof state.token === "string" && state.token ? state.token : null,
    generation: state.generation,
  };
  observeAuthTokenState(normalized);
  return normalized;
}

function requestGeneration(request: AuthRequest | RequestInit | undefined): number {
  const generation = (request as AuthRequest | undefined)?.[AUTH_REQUEST_GENERATION];
  if (!validGeneration(generation)) {
    throw Object.assign(new Error("Authentication request has no credential generation"), {
      code: "AUTH_CONTEXT_UNVALIDATED",
    });
  }
  return generation;
}

function requestAuthorization(request: AuthRequest | RequestInit | undefined): string | null {
  const headers = new Headers(request?.headers);
  return headers.get("Authorization");
}

export async function assertAuthRequestCurrent(
  request: AuthRequest | RequestInit | undefined
): Promise<AuthTokenState> {
  const expectedGeneration = requestGeneration(request);
  const state = await readAuthTokenState();
  const expectedAuthorization = state.token ? `Bearer ${state.token}` : null;
  if (
    state.generation !== expectedGeneration ||
    requestAuthorization(request) !== expectedAuthorization
  ) {
    throw Object.assign(new Error("Authentication context changed during request"), {
      code: "AUTH_CONTEXT_CHANGED",
    });
  }
  return state;
}

export async function prepareAuthRequest<T extends AuthRequest>(request: T): Promise<T> {
  const state = await readAuthTokenState();
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  else headers.delete("Authorization");
  return Object.assign(request, {
    headers,
    credentials: "omit" as RequestCredentials,
    [AUTH_REQUEST_GENERATION]: state.generation,
  });
}

export async function authContextFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  await assertAuthRequestCurrent(init);
  try {
    const response = await globalThis.fetch(input, { ...init, credentials: "omit" });
    await assertAuthRequestCurrent(init);
    return response;
  } catch (error) {
    // A credential boundary is more actionable than a simultaneous network
    // failure and must prevent stale session data from being trusted.
    await assertAuthRequestCurrent(init);
    // Better Auth cancels a session request whenever it starts another one: a
    // cancelled request says nothing about the server.
    if (isGetSessionRequest((init ?? {}) as AuthRequest) && !init?.signal?.aborted) {
      // Keep the session binding so a transient refetch failure keeps
      // presenting the account. A real 401 clears it via handleAuthRequestError.
      markRefetchFailed(requestGeneration(init));
      await noteSessionUnreachable(requestGeneration(init));
    }
    throw error;
  }
}

function isGetSessionRequest(request: AuthRequest): boolean {
  try {
    const path = new URL(String(request.url), window.location.origin).pathname;
    return path.endsWith("/get-session");
  } catch {
    return false;
  }
}

function resolvedUserId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const user = (data as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function sessionUser(data: unknown): unknown {
  return data && typeof data === "object" ? (data as { user?: unknown }).user : null;
}

function recordSessionResolution(generation: number, userId: string | null): void {
  sessionAnsweredAt = Date.now();
  update((current) => ({
    ...current,
    sessionResolved: true,
    sessionGeneration: generation,
    sessionUserId: userId,
    // A stable refresh for the same user may keep its validated lease. A null
    // or changed-user response stops sync immediately, including while
    // destructive cleanup waits out the grace period.
    validatedGeneration:
      userId &&
      current.sessionResolved &&
      current.sessionUserId === userId &&
      current.sessionGeneration === generation
        ? current.validatedGeneration
        : null,
    // The same account keeps being presented until reconciliation validates
    // it, so coming back online never passes through a signed-out state.
    offlineAccount: current.offlineAccount?.userId === userId ? current.offlineAccount : null,
    // A resolution with no user is the server's verdict too: a later transport
    // failure clears the resolution and must not bring the account back.
    sessionRejectedGeneration: userId ? null : generation,
    refetchFailedGeneration: null,
  }));
}

function withoutSessionResolution(
  current: RendererAuthContextSnapshot,
  generation: number
): RendererAuthContextSnapshot {
  if (current.sessionGeneration !== generation) return current;
  return {
    ...current,
    sessionResolved: false,
    sessionGeneration: null,
    sessionUserId: null,
    validatedGeneration: null,
    refetchFailedGeneration: null,
  };
}

function markRefetchFailed(generation: number): void {
  update((current) => ({
    ...current,
    validatedGeneration: null,
    refetchFailedGeneration:
      current.sessionResolved && current.sessionGeneration === generation
        ? generation
        : current.refetchFailedGeneration,
  }));
}

export async function handleAuthRequestResponse(context: { request: AuthRequest }): Promise<void> {
  await assertAuthRequestCurrent(context.request);
}

export async function handleAuthRequestSuccess(context: AuthSuccessContext): Promise<void> {
  const requestState = await assertAuthRequestCurrent(context.request);
  let resolvedState = requestState;
  const rotatedToken = context.response.headers.get("set-auth-token");
  if (rotatedToken) {
    const result = await window.electronAPI?.authSetToken?.(rotatedToken, requestState.generation);
    if (!result?.success || !validGeneration(result.generation)) {
      throw Object.assign(new Error("Authentication token changed before rotation completed"), {
        code: result?.code ?? "AUTH_CONTEXT_CHANGED",
      });
    }
    resolvedState = {
      token: typeof result.token === "string" && result.token ? result.token : null,
      generation: result.generation,
    };
    observeAuthTokenState(resolvedState);
  }
  const current = await readAuthTokenState();
  if (current.generation !== resolvedState.generation || current.token !== resolvedState.token) {
    throw Object.assign(new Error("Authentication context changed after response"), {
      code: "AUTH_CONTEXT_CHANGED",
    });
  }
  if (isGetSessionRequest(context.request)) {
    const userId = resolvedUserId(context.data);
    recordSessionResolution(current.generation, userId);
    // A server answer for a session that is already validated refreshes the
    // profile an offline launch may present; the first validation is saved by
    // useAuth once reconciliation commits it.
    if (userId && getValidatedAuthGeneration() === current.generation) {
      writeOfflineAccountProfile(sessionUser(context.data));
    }
  }
}

export async function handleAuthRequestError(context: AuthErrorContext): Promise<void> {
  const generation = requestGeneration(context.request);
  await assertAuthRequestCurrent(context.request);
  if (!isGetSessionRequest(context.request)) return;
  // Better Auth answers a dead credential with 401 (or 200 and no user). Any
  // other status, a 403 or 404 from a proxy or firewall included, says nothing
  // about the credential.
  if (context.response?.status !== 401) {
    markRefetchFailed(generation);
    await noteSessionUnreachable(generation, { clearSession: true });
    return;
  }
  // The rejection outlives this run's generation counter only through the
  // saved profile, so drop it: a later offline launch stays a guest.
  clearOfflineAccountProfile();
  update((current) => ({
    ...withoutSessionResolution(current, generation),
    offlineAccount: null,
    sessionRejectedGeneration: generation,
  }));
}

function hasSessionVerdict(current: RendererAuthContextSnapshot, generation: number): boolean {
  return (
    (current.sessionResolved && current.sessionGeneration === generation) ||
    current.sessionRejectedGeneration === generation
  );
}

function offlineEligible(current: RendererAuthContextSnapshot, generation: number): boolean {
  return (
    current.observedGeneration === generation &&
    current.hasToken &&
    !hasSessionVerdict(current, generation)
  );
}

/**
 * get-session for `generation` got no answer. Main's account binding is keyed
 * by a hash of the exact bearer it validated, so when it still names an
 * account for this generation that account can be presented read-only.
 * `clearSession` drops the session resolution in the same update, after the
 * binding was read, so the account is never shown signed out in between.
 */
async function noteSessionUnreachable(
  generation: number,
  { clearSession = false }: { clearSession?: boolean } = {}
): Promise<void> {
  const settle = (current: RendererAuthContextSnapshot): RendererAuthContextSnapshot =>
    clearSession ? withoutSessionResolution(current, generation) : current;
  // Only the control panel resolves its own session. Every other window
  // fails get-session by design and follows main's scope (accountScopeMirror).
  let scope: { accountId: string; authGeneration: number } | null | undefined = null;
  if (isControlPanelWindow() && offlineEligible(settle(snapshot), generation)) {
    try {
      scope = await window.electronAPI?.getActiveAccountScope?.();
    } catch {
      scope = null;
    }
  }
  const userId = typeof scope?.accountId === "string" ? scope.accountId : null;
  update((current) => {
    const next = settle(current);
    if (!userId || scope?.authGeneration !== generation || !offlineEligible(next, generation)) {
      return next;
    }
    return { ...next, offlineAccount: { userId, generation } };
  });
}

/**
 * The account to present read-only: while get-session has no answer, and
 * after the server confirmed that same account until reconciliation
 * validates it.
 */
export function getOfflineAccount(): OfflineAccount | null {
  const account = snapshot.offlineAccount;
  if (
    !account ||
    snapshot.observedGeneration !== account.generation ||
    !snapshot.hasToken ||
    snapshot.sessionRejectedGeneration === account.generation
  ) {
    return null;
  }
  if (!snapshot.sessionResolved || snapshot.sessionGeneration !== account.generation) {
    return account;
  }
  return snapshot.sessionUserId === account.userId &&
    snapshot.validatedGeneration !== account.generation
    ? account
    : null;
}

/**
 * An account is shown without a validated credential: offline, or bound by a
 * session whose refetch then failed. Sync and account actions wait on a verdict.
 */
export function sessionAwaitsVerdict(): boolean {
  if (getOfflineAccount()) return true;
  const userId = snapshot.sessionUserId;
  return userId != null && getBoundSessionGeneration(userId) != null && !hasValidatedAuthContext();
}

export function getSessionAnsweredAt(): number | null {
  return sessionAnsweredAt;
}

export function getBoundSessionGeneration(userId: string | null): number | null {
  if (
    !snapshot.sessionResolved ||
    snapshot.sessionGeneration == null ||
    snapshot.sessionGeneration !== snapshot.observedGeneration ||
    snapshot.sessionUserId !== userId
  ) {
    return null;
  }
  if (userId && !snapshot.hasToken) return null;
  return snapshot.sessionGeneration;
}

export function commitValidatedAuthContext(generation: number, userId: string): boolean {
  if (
    !validGeneration(generation) ||
    !userId ||
    getBoundSessionGeneration(userId) !== generation ||
    !snapshot.hasToken
  ) {
    return false;
  }
  if (snapshot.refetchFailedGeneration === generation) return false;
  update((current) => ({ ...current, validatedGeneration: generation, offlineAccount: null }));
  return true;
}

export function invalidateValidatedAuthContext(): void {
  update((current) => ({ ...current, validatedGeneration: null }));
}

export function getValidatedAuthGeneration(): number | null {
  return snapshot.validatedGeneration === snapshot.observedGeneration && snapshot.hasToken
    ? snapshot.validatedGeneration
    : null;
}

export function hasValidatedAuthContext(): boolean {
  return getValidatedAuthGeneration() != null;
}

export async function assertAuthGenerationCurrent(generation: number): Promise<void> {
  const state = await readAuthTokenState();
  if (state.generation !== generation || !state.token) {
    throw Object.assign(new Error("Authentication context changed during reconciliation"), {
      code: "AUTH_CONTEXT_CHANGED",
    });
  }
}

export function resetAuthRequestContextForTests(): void {
  snapshot = { ...EMPTY_SNAPSHOT, revision: snapshot.revision + 1 };
  sessionAnsweredAt = null;
}
