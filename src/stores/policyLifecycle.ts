// How often a window asks main for the effective policy. Main reads the server again only once
// the verdict it holds is stale: five minutes for a managed account, fifteen for an unmanaged
// one (workspacePolicyManager).
export const POLICY_SUCCESS_REFRESH_MS = 5 * 60 * 1000;
