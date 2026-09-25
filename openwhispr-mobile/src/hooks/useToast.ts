import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastType } from '@/components/ui/Toast';

const TOAST_MS = 3000;
// Errors carry something to act on, so they stay long enough to read.
const ERROR_TOAST_MS = 6000;

export interface ToastState {
  message: string;
  type: ToastType;
  visible: boolean;
  // Changes on every show, so the same message shown twice still replays.
  showId: number;
}

export function useToast(): {
  toast: ToastState;
  showToast: (message: string, type: ToastType) => void;
} {
  const [toast, setToast] = useState<ToastState>({
    message: '',
    type: 'info',
    visible: false,
    showId: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => (): void => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const showToast = useCallback((message: string, type: ToastType): void => {
    if (timer.current) clearTimeout(timer.current);
    setToast((current) => ({ message, type, visible: true, showId: current.showId + 1 }));
    timer.current = setTimeout(
      () => setToast((current) => ({ ...current, visible: false })),
      type === 'error' ? ERROR_TOAST_MS : TOAST_MS,
    );
  }, []);

  return { toast, showToast };
}
