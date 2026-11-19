import { create } from 'zustand';
import {
  setBubbleAppearance,
  type BubbleAppearance,
} from '../../../modules/android-dictation/src/appearance';
import { useConfigStore } from '@/store/useConfigStore';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import type { SettingsKey } from './strings';

const KEY = 'android-bubble-appearance-v1';
export const BUBBLE_SIZE = { min: 48, max: 80 };
type Look = Omit<BubbleAppearance, 'size'>;
export const DEFAULT_LOOK: Look = {
  opacity: 0.8,
  shrinkWhenIdle: true,
  shrinkToDot: false,
  shrinkInSearch: false,
};
export const DEFAULT_SIZE = 64;

function saved(): Look {
  try {
    return { ...DEFAULT_LOOK, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULT_LOOK;
  }
}

/** The bubble's look. Size stays in the account config (Home reads it too); the rest is per phone. */
export const useBubbleLook = create<Look>(() => saved());

export function sizeLabel(size: number): SettingsKey {
  return size < 56 ? 'small' : size < 72 ? 'medium' : 'large';
}

/** Applies a change to the running bubble at once and keeps it for the next start. */
export function applyBubbleLook(change: Partial<Look> & { size?: number }) {
  const { size, ...look } = change;
  const next = { ...useBubbleLook.getState(), ...look };
  useBubbleLook.setState(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // The native side keeps its own copy; this one only feeds the screen.
  }
  const currentSize = size ?? useConfigStore.getState().config?.androidBubbleSize ?? DEFAULT_SIZE;
  setBubbleAppearance({ size: currentSize, ...next });
}

export function saveBubbleSize(size: number) {
  void useConfigStore.getState().updateConfig({ androidBubbleSize: size });
}

export type HoldAction = 'menu' | 'nothing';
const HOLD_KEY = 'android-bubble-hold-v1';

function savedHold(): HoldAction {
  try {
    return localStorage.getItem(HOLD_KEY) === 'nothing' ? 'nothing' : 'menu';
  } catch {
    return 'menu';
  }
}

/** Settings › Bubble › Hold the bubble: show the menu (default) or nothing. Per phone. */
export const useHoldAction = create<{ value: HoldAction }>(() => ({ value: savedHold() }));

/** Saves the choice and tells the running bubble, which keeps it for its next start. */
export function setHoldAction(value: HoldAction) {
  useHoldAction.setState({ value });
  try {
    localStorage.setItem(HOLD_KEY, value);
  } catch {
    // The native side keeps its own copy; this one only feeds the screen.
  }
  AndroidDictation?.setMenuContext?.({ holdAction: value });
}
