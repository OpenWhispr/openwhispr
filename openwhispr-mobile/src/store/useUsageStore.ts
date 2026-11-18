import { create } from 'zustand';
import { createUsageState, defaultUsageLifecycle, type UsageStore } from './createUsageStore';

export { getUsageOwnerKey } from './createUsageStore';
export type { UsageLoadResult } from './createUsageStore';
export const useUsageStore = create<UsageStore>((set, get) =>
  createUsageState(set, get, defaultUsageLifecycle),
);
