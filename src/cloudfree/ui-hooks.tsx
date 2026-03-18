/**
 * CloudFree UI Hooks (renderer-side)
 *
 * Exports CloudFree-specific UI pieces for use in upstream components.
 * After an upstream merge, just re-apply the small edits in SettingsModal.
 */

import React from "react";

export { CloudFreeNetworkPanel } from "./components/CloudFreeNetworkPanel";

export const defaultSettingsSection = "general";

const HIDDEN_SECTIONS = new Set(["account", "plansBilling", "agentMode"]);

const CloudFreeSettingsItem = {
  id: "cloudfree" as const,
  label: "CloudFree",
  icon: ShieldIcon,
  description: "Network guard, allowlist, and fork settings",
  group: "CloudFree",
};

/**
 * flatMap callback for SettingsModal sidebar items.
 * Filters out hidden sections and appends the CloudFree pane.
 */
export function settingsMap<T extends { id: string }>(
  item: T,
  _index: number,
  arr: T[]
): T[] {
  if (HIDDEN_SECTIONS.has(item.id)) return [];
  // Append CloudFree item after the last upstream item
  if (item === arr[arr.length - 1]) return [item, CloudFreeSettingsItem as unknown as T];
  return [item];
}

// Inline shield icon to avoid adding a lucide dependency here
function ShieldIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
