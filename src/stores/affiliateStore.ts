import { create } from "zustand";
import { cloudGetForAuthGeneration, cloudPostForAuthGeneration } from "../services/cloudApi";
import {
  getAuthRequestContextSnapshot,
  getValidatedAuthGeneration,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";
import { useSettingsStore } from "./settingsStore";

interface Candidate {
  link: string;
  clickId: string | null;
  saved: boolean;
}
interface AffiliateState extends Candidate {
  enabled: boolean;
  checking: boolean;
  error: "unavailable" | "privacy" | "review" | null;
  setLink: (link: string) => void;
}
const empty = { link: "", clickId: null, saved: false };
let revision = 0;
let failedWrite: {
  revision: number;
  link: string;
  userId: string | null | undefined;
} | null = null;
let writes: Promise<unknown> = Promise.resolve();
let loading: Promise<void> | null = null;
let submitting: Promise<boolean> | null = null;
let submittingGeneration: number | null = null;
let observedUser: string | null = null;
let observedGeneration: number | null = null;
let nativeGeneration: number | null = null;
let nativeCandidate: Candidate = empty;

async function saveNativeCandidate(
  candidate: Candidate,
  generation: number,
  expectedCandidate: Candidate
): Promise<void> {
  await window.electronAPI?.saveAffiliateCandidate?.({
    ...candidate,
    generation,
    expectedCandidate,
  });
  nativeCandidate = candidate;
}

function candidateChanged(error: unknown): boolean {
  // Electron prefixes errors thrown by IPC handlers with the channel name.
  return error instanceof Error && error.message.includes("REFERRAL_CONTEXT_CHANGED");
}

export const useAffiliateStore = create<AffiliateState>((set) => ({
  ...empty,
  enabled: false,
  checking: false,
  error: null,
  setLink(link): void {
    if (useAffiliateStore.getState().saved) return;
    const version = ++revision;
    set({ link, clickId: null, error: null });
    const context = getAuthRequestContextSnapshot();
    const generation = context.observedGeneration ?? nativeGeneration;
    const userId = context.sessionResolved
      ? context.sessionUserId
      : context.observedGeneration != null && !context.hasToken
        ? null
        : undefined;
    if (failedWrite?.revision === version - 1) failedWrite = { revision: version, link, userId };
    if (generation == null) return;
    writes = writes
      .catch(() => {})
      .then(async (): Promise<void> => {
        while (version === revision) {
          try {
            await saveNativeCandidate(
              { link, clickId: null, saved: false },
              generation,
              nativeCandidate
            );
            if (version === revision) failedWrite = null;
            return;
          } catch (error: unknown) {
            if (version !== revision) return;
            if (!candidateChanged(error)) throw error;
            // Reload directly: refresh waits for this write queue to finish.
            const result = await window.electronAPI?.getAffiliateCandidate?.();
            if (version !== revision) return;
            if (!result || result.generation !== generation) throw error;
            const { link: currentLink, clickId, saved } = result.candidate ?? empty;
            nativeCandidate = { link: currentLink, clickId, saved };
            if (saved) {
              failedWrite = null;
              set(nativeCandidate);
              return;
            }
          }
        }
      })
      .catch(() => {
        if (version === revision) {
          failedWrite = { revision: version, link, userId };
          set({ error: "unavailable" });
        }
      });
  },
}));

async function refresh(): Promise<void> {
  if (loading) return loading;
  loading = (async (): Promise<void> => {
    let version: number;
    do {
      version = revision;
      try {
        await writes;
        if (revision !== version) continue;
        const result = await window.electronAPI?.getAffiliateCandidate?.();
        if (!result) return;
        if (revision !== version) continue;
        nativeGeneration = result.generation;
        const { link, clickId, saved } = result.candidate ?? empty;
        nativeCandidate = { link, clickId, saved };
        // Preserve a failed edit, but a creator already saved for this account still wins.
        if (saved) failedWrite = null;
        useAffiliateStore.setState({
          enabled: !!result.config,
          ...(failedWrite?.revision === version ? {} : nativeCandidate),
        });
        const generation = getValidatedAuthGeneration();
        if (!result.config || generation == null) continue;
        const response = await cloudGetForAuthGeneration<{
          data: { persisted: boolean; status: string | null };
        }>("/api/affiliate/status", generation);
        if (revision !== version || generation !== getValidatedAuthGeneration()) continue;
        if (response.data.persisted) {
          failedWrite = null;
          useAffiliateStore.setState({
            saved: true,
            error: response.data.status === "review" ? "review" : null,
          });
        }
      } catch {
        // Offline startup keeps the local candidate for retry.
      }
      // Every waiter needs the newest candidate, including signed-out callers
      // that cannot trigger another refresh through automatic attribution.
    } while (version !== revision);
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export async function prepareAffiliateCheckout(): Promise<boolean> {
  const generation = getValidatedAuthGeneration();
  if (generation == null) return false;
  if (submitting) {
    const sameGeneration = submittingGeneration === generation;
    const result = await submitting;
    if (generation !== getValidatedAuthGeneration()) return false;
    return sameGeneration ? result : prepareAffiliateCheckout();
  }
  submittingGeneration = generation;
  submitting = (async (): Promise<boolean> => {
    while (generation === getValidatedAuthGeneration()) {
      await refresh();
      if (generation !== getValidatedAuthGeneration()) return false;
      const state = useAffiliateStore.getState();
      if (!state.enabled || state.saved) return true;
      if (failedWrite?.revision === revision) {
        state.setLink(state.link);
        await writes;
        if (failedWrite?.revision === revision) return false;
        continue;
      }
      if (!state.link.trim() && !state.clickId) return true;
      const version = revision;
      const current = (): boolean =>
        version === revision && generation === getValidatedAuthGeneration();
      const permitted = (): boolean => current() && useSettingsStore.getState().telemetryEnabled;
      if (!permitted()) {
        useAffiliateStore.setState({ error: "privacy" });
        return false;
      }
      useAffiliateStore.setState({ checking: true, error: null });
      try {
        let expectedCandidate = nativeCandidate;
        let clickId = state.clickId;
        if (!clickId) {
          await cloudPostForAuthGeneration(
            "/api/affiliate/check-link",
            { link: state.link },
            generation
          );
          if (!permitted()) continue;
          const resolved = await window.electronAPI?.resolveAffiliateLink?.(state.link, generation);
          if (!permitted()) continue;
          if (!resolved) return false;
          clickId = resolved.clickId;
          const resolvedCandidate = { link: resolved.link, clickId, saved: false };
          await saveNativeCandidate(resolvedCandidate, generation, expectedCandidate);
          expectedCandidate = resolvedCandidate;
          if (!current()) continue;
          useAffiliateStore.setState({ clickId });
        }
        if (!permitted()) continue;
        const result = await cloudPostForAuthGeneration<{
          data: { persisted: boolean; status: string };
        }>(
          "/api/affiliate/claim",
          { ...(state.link ? { link: state.link } : {}), clickId, source: "desktop" },
          generation
        );
        if (!current()) continue;
        if (result.data.persisted !== true) return false;
        await saveNativeCandidate(
          { link: state.link, clickId, saved: true },
          generation,
          expectedCandidate
        );
        if (!current()) continue;
        useAffiliateStore.setState({
          saved: true,
          error: result.data.status === "review" ? "review" : null,
        });
        return true;
      } catch (error: unknown) {
        if (candidateChanged(error)) {
          revision++;
          continue;
        }
        if (current()) {
          useAffiliateStore.setState({ error: "unavailable" });
          return false;
        }
      } finally {
        // Submissions are serialized, so this request always owns the busy flag.
        useAffiliateStore.setState({ checking: false });
      }
    }
    return false;
  })().finally(() => {
    submitting = null;
    submittingGeneration = null;
  });
  return submitting;
}

let users = 0;
let stop: (() => void) | null = null;
export function startAffiliateAttribution(): () => void {
  if (users++ === 0) {
    const reconcile = (): void => {
      const context = getAuthRequestContextSnapshot();
      const failedEdit = failedWrite?.revision === revision ? failedWrite : null;
      const signedOut =
        (context.observedGeneration != null && !context.hasToken) ||
        (context.sessionResolved && context.sessionUserId === null);
      const discardFailedEdit =
        failedEdit?.userId != null &&
        (signedOut || (context.sessionResolved && context.sessionUserId !== failedEdit.userId));
      if (
        context.observedGeneration !== observedGeneration ||
        (context.sessionResolved && context.sessionUserId !== observedUser) ||
        discardFailedEdit
      ) {
        observedGeneration = context.observedGeneration;
        observedUser = context.sessionUserId;
        revision++;
        failedWrite =
          failedEdit && failedEdit.userId !== undefined && !discardFailedEdit
            ? { ...failedEdit, revision }
            : null;
        // Keep an account's failed edit private until its rotated credentials resolve.
        const failedLink =
          failedWrite &&
          (failedWrite.userId === null || failedWrite.userId === context.sessionUserId)
            ? failedWrite.link
            : null;
        useAffiliateStore.setState({
          ...empty,
          link: failedLink ?? "",
          checking: false,
          error: failedLink === null ? null : "unavailable",
        });
      }
      if (failedWrite && getValidatedAuthGeneration() != null)
        failedWrite.userId = context.sessionUserId;
      void refresh().then(() => {
        if (getValidatedAuthGeneration() != null && useSettingsStore.getState().telemetryEnabled)
          void prepareAffiliateCheckout();
      });
    };
    const auth = subscribeAuthRequestContext(reconcile);
    const link = window.electronAPI?.onAffiliateLink?.(() => {
      revision++;
      reconcile();
    });
    window.addEventListener("focus", reconcile);
    reconcile();
    stop = () => {
      auth();
      link?.();
      window.removeEventListener("focus", reconcile);
    };
  }
  return () => {
    if (--users === 0) {
      stop?.();
      stop = null;
    }
  };
}
