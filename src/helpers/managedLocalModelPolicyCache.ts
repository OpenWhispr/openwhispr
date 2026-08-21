import { isValidManagedEnterpriseLocalModels } from "./enterpriseManagedConfig.mjs";
import type { ManagedEnterpriseLocalModels } from "../types/enterpriseIdentity";
import { OPENWHISPR_API_URL } from "../config/constants";

export const MANAGED_LOCAL_MODEL_POLICY_SNAPSHOTS_KEY = "enterpriseManagedLocalPolicySnapshotsV1";
const UNCONFIGURED_API_ORIGIN = "openwhispr-api:unconfigured";

interface ManagedLocalModelPolicySnapshotEntry {
  apiOrigin: string;
  accountId: string;
  workspaceId: string;
  localModels: ManagedEnterpriseLocalModels | null;
  managedInferenceConfigured: boolean;
}

interface ManagedLocalModelPolicySnapshotEnvelope {
  version: 2;
  entries: ManagedLocalModelPolicySnapshotEntry[];
}

export interface ManagedLocalModelPolicySnapshot {
  localModels: ManagedEnterpriseLocalModels | null;
  managedInferenceConfigured: boolean;
}

function isValidIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeApiOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return UNCONFIGURED_API_ORIGIN;
    }
    return url.origin;
  } catch {
    return UNCONFIGURED_API_ORIGIN;
  }
}

function normalizeEntry(
  value: unknown,
  version: 1 | 2
): ManagedLocalModelPolicySnapshotEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ManagedLocalModelPolicySnapshotEntry>;
  if (
    entry.apiOrigin !== normalizeApiOrigin(entry.apiOrigin ?? "") ||
    !isValidIdentity(entry.accountId) ||
    !isValidIdentity(entry.workspaceId) ||
    (entry.localModels !== null && !isValidManagedEnterpriseLocalModels(entry.localModels))
  ) {
    return null;
  }
  if (version === 1) {
    return entry.localModels === null
      ? null
      : {
          apiOrigin: entry.apiOrigin,
          accountId: entry.accountId,
          workspaceId: entry.workspaceId,
          localModels: entry.localModels,
          managedInferenceConfigured: true,
        };
  }
  if (
    typeof entry.managedInferenceConfigured !== "boolean" ||
    (entry.localModels !== null && !entry.managedInferenceConfigured)
  ) {
    return null;
  }
  return {
    apiOrigin: entry.apiOrigin,
    accountId: entry.accountId,
    workspaceId: entry.workspaceId,
    localModels: entry.localModels,
    managedInferenceConfigured: entry.managedInferenceConfigured,
  };
}

function readValidEntries(): ManagedLocalModelPolicySnapshotEntry[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MANAGED_LOCAL_MODEL_POLICY_SNAPSHOTS_KEY) ?? "null"
    ) as { version?: unknown; entries?: unknown } | null;
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries
      .map((entry) => normalizeEntry(entry, parsed.version as 1 | 2))
      .filter((entry): entry is ManagedLocalModelPolicySnapshotEntry => entry !== null);
  } catch {
    return [];
  }
}

export function readManagedLocalModelPolicySnapshot(
  accountId: string,
  workspaceId: string,
  apiUrl: string = OPENWHISPR_API_URL
): ManagedLocalModelPolicySnapshot | null {
  const apiOrigin = normalizeApiOrigin(apiUrl);
  const entry = readValidEntries().find(
    (candidate) =>
      candidate.apiOrigin === apiOrigin &&
      candidate.accountId === accountId &&
      candidate.workspaceId === workspaceId
  );
  return entry
    ? {
        localModels: entry.localModels,
        managedInferenceConfigured: entry.managedInferenceConfigured,
      }
    : null;
}

export function writeManagedLocalModelPolicySnapshot(
  accountId: string,
  workspaceId: string,
  localModels: ManagedEnterpriseLocalModels | null,
  managedInferenceConfigured: boolean,
  apiUrl: string = OPENWHISPR_API_URL
): void {
  if (
    (localModels !== null && !isValidManagedEnterpriseLocalModels(localModels)) ||
    typeof managedInferenceConfigured !== "boolean" ||
    (localModels !== null && !managedInferenceConfigured)
  ) {
    return;
  }
  const apiOrigin = normalizeApiOrigin(apiUrl);
  const entries = readValidEntries().filter(
    (candidate) =>
      candidate.apiOrigin !== apiOrigin ||
      candidate.accountId !== accountId ||
      candidate.workspaceId !== workspaceId
  );
  entries.push({
    apiOrigin,
    accountId,
    workspaceId,
    localModels,
    managedInferenceConfigured,
  });
  const envelope: ManagedLocalModelPolicySnapshotEnvelope = { version: 2, entries };
  try {
    localStorage.setItem(MANAGED_LOCAL_MODEL_POLICY_SNAPSHOTS_KEY, JSON.stringify(envelope));
  } catch {
    // Storage failures must not prevent the current renderer from enforcing its in-memory copy.
  }
}
