import { create } from 'zustand';

// A recoverable result stays in memory even when history is disabled. It is
// never copied to the clipboard automatically or written to a hidden file.
export const useBubbleResult = create<{
  text: string;
  error: string;
  setResult: (text: string, error?: string) => void;
  dismiss: () => void;
}>((set) => ({
  text: '',
  error: '',
  setResult: (text, error = '') => set({ text, error }),
  dismiss: () => set({ text: '', error: '' }),
}));
