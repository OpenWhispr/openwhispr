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
let writes: Promise<unknown> = Promise.resolve();
let loading: Promise<void> | null = null;
let submitting: Promise<boolean> | null = null;
let observedUser: string | null = null;
let observedGeneration: number | null = null;
let nativeGeneration: number | null = null;

export const useAffiliateStore = create<AffiliateState>((set) => ({
  ...empty,
  enabled: false,
  checking: false,
  error: null,
  setLink(link) {
    if (useAffiliateStore.getState().saved) return;
    const version = ++revision;
    set({ link, clickId: null, error: null });
    const generation = getAuthRequestContextSnapshot().observedGeneration ?? nativeGeneration;
    if (generation == null) return;
    writes = writes
      .catch(() => {})
      .then(() =>
        window.electronAPI?.saveAffiliateCandidate?.({
          link,
          clickId: null,
          saved: false,
          generation,
        })
      )
      .catch(() => {
        if (version === revision) set({ error: "unavailable" });
      });
  },
}));

async function refresh(): Promise<void> {
  if (loading) return loading;
  const version = revision;
  loading = (async () => {
    await writes;
    const result = await window.electronAPI?.getAffiliateCandidate?.();
    if (!result || revision !== version) return;
    nativeGeneration = result.generation;
    useAffiliateStore.setState({ enabled: !!result.config, ...(result.candidate ?? empty) });
    const generation = getValidatedAuthGeneration();
    if (!result.config || generation == null) return;
    const response = await cloudGetForAuthGeneration<{
      data: { persisted: boolean; status: string | null };
    }>("/api/affiliate/status", generation);
    if (revision !== version || generation !== getValidatedAuthGeneration()) return;
    if (response.data.persisted) {
      useAffiliateStore.setState({
        saved: true,
        error: response.data.status === "review" ? "review" : null,
      });
    }
  })()
    .catch(() => {
      /* Offline startup keeps the local candidate for retry. */
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function prepareAffiliateCheckout(): Promise<boolean> {
  if (submitting) return submitting;
  submitting = (async () => {
    await refresh();
    const state = useAffiliateStore.getState();
    if (!state.enabled || state.saved || (!state.link.trim() && !state.clickId)) return true;
    const generation = getValidatedAuthGeneration();
    if (generation == null) return false;
    const version = revision;
    const current = () => version === revision && generation === getValidatedAuthGeneration();
    const permitted = () => current() && useSettingsStore.getState().telemetryEnabled;
    if (!permitted()) {
      useAffiliateStore.setState({ error: "privacy" });
      return false;
    }
    useAffiliateStore.setState({ checking: true, error: null });
    try {
      let clickId = state.clickId;
      if (!clickId) {
        await cloudPostForAuthGeneration(
          "/api/affiliate/check-link",
          { link: state.link },
          generation
        );
        if (!permitted()) return false;
        const resolved = await window.electronAPI?.resolveAffiliateLink?.(state.link, generation);
        if (!resolved || !permitted()) return false;
        clickId = resolved.clickId;
        await window.electronAPI?.saveAffiliateCandidate?.({
          link: resolved.link,
          clickId,
          saved: false,
          generation,
        });
        if (!current()) return false;
        useAffiliateStore.setState({ clickId });
      }
      if (!permitted()) return false;
      const result = await cloudPostForAuthGeneration<{
        data: { persisted: boolean; status: string };
      }>(
        "/api/affiliate/claim",
        { ...(state.link ? { link: state.link } : {}), clickId, source: "desktop" },
        generation
      );
      if (!current() || result.data.persisted !== true) return false;
      await window.electronAPI?.saveAffiliateCandidate?.({
        link: state.link,
        clickId,
        saved: true,
        generation,
      });
      if (!current()) return false;
      useAffiliateStore.setState({
        saved: true,
        error: result.data.status === "review" ? "review" : null,
      });
      return true;
    } catch {
      if (current()) useAffiliateStore.setState({ error: "unavailable" });
      return false;
    } finally {
      if (current()) useAffiliateStore.setState({ checking: false });
    }
  })().finally(() => {
    submitting = null;
  });
  return submitting;
}

let users = 0;
let stop: (() => void) | null = null;
export function startAffiliateAttribution(): () => void {
  if (users++ === 0) {
    const reconcile = () => {
      const context = getAuthRequestContextSnapshot();
      if (
        context.observedGeneration !== observedGeneration ||
        (context.sessionResolved && context.sessionUserId !== observedUser)
      ) {
        observedGeneration = context.observedGeneration;
        observedUser = context.sessionUserId;
        revision++;
        useAffiliateStore.setState({ ...empty, checking: false, error: null });
      }
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
