import { useCallback, useEffect, useRef, useState } from "react";

interface CortiAccountState {
  isConnected: boolean;
  isLoaded: boolean;
  name: string | null;
  email: string | null;
  refresh: () => Promise<void>;
}

/**
 * Reads Corti auth state (including user name/email decoded from the JWT
 * access token) from the main process. Re-polls on window focus and supports
 * manual `refresh()` after sign-in / sign-out.
 */
export function useCortiAccount(): CortiAccountState {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const status = await window.electronAPI?.cortiGetAuthStatus?.();
    if (!mountedRef.current) return;
    setIsConnected(Boolean(status?.isConnected));
    setName(status?.user?.name ?? null);
    setEmail(status?.user?.email ?? null);
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { isConnected, isLoaded, name, email, refresh };
}
