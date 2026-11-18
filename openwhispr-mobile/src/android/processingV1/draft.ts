import { create } from 'zustand';
import type { KeySource } from './logic';

/**
 * Processing's unsaved "Your own API key" choice (9.1–9.11). It lives outside the screen so the
 * API key page (9.4) can hand a typed key back; nothing is saved until Save.
 */
export type KeyDraft = {
  /** Your own API key was chosen here and not saved yet. */
  open: boolean;
  dirty: boolean;
  provider: KeySource;
  model: string;
  /** A key typed on the API key page; empty means the saved one. */
  key: string;
  server: string;
  serverKey: string;
  speechModel: string;
  textModel: string;
};

export const EMPTY_DRAFT: KeyDraft = {
  open: false,
  dirty: false,
  provider: 'openai',
  model: '',
  key: '',
  server: '',
  serverKey: '',
  speechModel: '',
  textModel: '',
};

export const useKeyDraft = create<KeyDraft>(() => EMPTY_DRAFT);

/** Changes the draft and marks it unsaved. */
export function editDraft(change: Partial<KeyDraft>) {
  useKeyDraft.setState({ ...change, dirty: true });
}
