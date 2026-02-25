import { useEffect, useRef } from "react";
import { authClient, isWithinGracePeriod } from "../lib/neonAuth";
import logger from "../utils/logger";
import { useSettingsStore } from "../stores/settingsStore";

const useStaticSession = () => ({
  data: null,
  isPending: false,
  error: null,
  refetch: async () => null,
});

export function useAuth() {
  const useSession = authClient?.useSession ?? useStaticSession;
  const { data: session, isPending } = useSession();
  const user = session?.user ?? null;
  const rawIsSignedIn = Boolean(user);
  const gracePeriodActive = isWithinGracePeriod();

  // Only sync true to the store — signOut() handles setting false via localStorage + reload.
  // The Neon SDK's useSession() flickers in Electron (renderer can't access main process cookies).
  const isSignedIn = rawIsSignedIn || gracePeriodActive;

  const lastSyncedRef = useRef(false);

  useEffect(() => {
    if (!isPending && isSignedIn && !lastSyncedRef.current) {
      logger.debug(
        "Auth state sync",
        { isSignedIn, rawIsSignedIn, gracePeriod: gracePeriodActive },
        "auth"
      );
      useSettingsStore.getState().setIsSignedIn(true);
      lastSyncedRef.current = true;
    }
  }, [isSignedIn, rawIsSignedIn, gracePeriodActive, isPending]);

  return {
    isSignedIn,
    isLoaded: !isPending,
    session,
    user,
  };
}
