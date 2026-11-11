import { create } from "zustand";
import logger from "../utils/logger";
import type { EffectivePolicySnapshot } from "../types/policy";
import { POLICY_SUCCESS_REFRESH_MS } from "./policyLifecycle";
import type { PolicyDecisionSnapshot } from "./policyRules";

export interface PolicyState extends PolicyDecisionSnapshot {
  /** Account whose policy is represented by this renderer state. */
  accountId: string | null;
  authGeneration: number | null;
  revision: number;
  /** True once the org enforces a policy on this user. */
  managed: boolean;
  deviceReady: boolean;
  deviceManaged: boolean;
  workspaceManaged?: boolean;
  workspaceRequired?: boolean;
  localOnly: boolean;
  requireSignIn: boolean;
  code?: string;
  bootstrap: () => Promise<void>;
  // Main owns the effective verdict and broadcasts every account change, so
  // these only ask it for the current one.
  fetchPolicy: (accountId: string, authGeneration: number) => Promise<void>;
  clearPolicy: () => void;
  suspendPolicy: () => void;
}

let lifecycleListenersReady = false;
let appVersionPromise: Promise<string | null> | null = null;

function readAppVersion(): Promise<string | null> {
  if (!appVersionPromise) {
    const pending: Promise<string | null> =
      window.electronAPI
        .getAppVersion?.()
        .then((result) => result?.version ?? null)
        .catch((error) => {
          logger.error("Failed to read app version for workspace policy:", error);
          return null;
        }) ?? Promise.resolve(null);
    // An unknown version denies every managed action while hiding the update
    // banner that explains it, so never cache a failed read for the session.
    appVersionPromise = pending.then((version) => {
      if (!version) appVersionPromise = null;
      return version;
    });
  }
  return appVersionPromise;
}

let effectiveFetch: Promise<void> | null = null;

function applyEffectiveSnapshot(
  snapshot: EffectivePolicySnapshot,
  appVersion: string | null
): void {
  const current = usePolicyStore.getState();
  if (
    snapshot.revision < current.revision ||
    (current.authGeneration != null && snapshot.authGeneration < current.authGeneration)
  )
    return;
  // A settled verdict stays while the same account's next one loads, as a
  // rotated token keeps its account: a running stream isn't refused meanwhile.
  const settled = current.status === "managed" || current.status === "unmanaged";
  const keepSettled =
    snapshot.status === "loading" &&
    snapshot.deviceReady &&
    settled &&
    snapshot.accountId === current.accountId;
  usePolicyStore.setState({
    ...snapshot,
    ...(keepSettled
      ? {
          status: current.status,
          managed: current.managed,
          policy: current.policy,
          workspaceManaged: current.workspaceManaged,
          code: current.code,
        }
      : {
          code: snapshot.code,
          status: snapshot.success ? (snapshot.managed ? "managed" : "unmanaged") : snapshot.status,
        }),
    appVersion,
  });
}

export function refreshEffectivePolicy(): Promise<void> {
  ensurePolicyLifecycleListeners();
  if (effectiveFetch) return effectiveFetch;
  const read = window.electronAPI.getEffectivePolicy;
  if (!read) {
    usePolicyStore.setState({ deviceReady: true });
    return Promise.resolve();
  }
  const pending = (async () => {
    const revision = usePolicyStore.getState().revision;
    try {
      const [snapshot, appVersion] = await Promise.all([read(), readAppVersion()]);
      applyEffectiveSnapshot(snapshot, appVersion);
    } catch (error) {
      if (usePolicyStore.getState().revision !== revision) return;
      logger.error("Failed to read effective policy:", error);
      usePolicyStore.setState({
        status: "error",
        deviceReady: true,
        code: "DEVICE_POLICY_INVALID",
        policy: null,
      });
    }
  })();
  effectiveFetch = pending.finally(() => {
    effectiveFetch = null;
  });
  return effectiveFetch;
}

function ensurePolicyLifecycleListeners(): void {
  if (lifecycleListenersReady) return;
  lifecycleListenersReady = true;
  window.electronAPI.onEffectivePolicyChanged?.((snapshot) => {
    void readAppVersion().then((version) => applyEffectiveSnapshot(snapshot, version));
  });
  const refresh = (): void => void refreshEffectivePolicy();
  window.addEventListener("online", refresh);
  window.addEventListener("focus", refresh);
  window.setInterval(refresh, POLICY_SUCCESS_REFRESH_MS);
}

export const usePolicyStore = create<PolicyState>()(() => ({
  deviceReady: false,
  deviceManaged: false,
  localOnly: false,
  requireSignIn: false,
  bootstrap: refreshEffectivePolicy,
  accountId: null,
  authGeneration: null,
  revision: 0,
  status: "idle",
  managed: false,
  policy: null,
  appVersion: null,
  fetchPolicy: refreshEffectivePolicy,
  clearPolicy: (): void => void refreshEffectivePolicy(),
  suspendPolicy: (): void => void refreshEffectivePolicy(),
}));
