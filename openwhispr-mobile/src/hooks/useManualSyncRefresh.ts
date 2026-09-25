import { useCallback, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { requestSync } from '@/sync/syncEngine';

interface ManualSyncRefresh {
  refreshing: boolean;
  onRefresh: () => void;
}

// Pull-to-refresh state for a screen that syncs on pull.
//
// The spinner follows only the sync the user pulled for, never the global sync
// status: background syncs (after a dictation, on foreground) would otherwise
// begin and end the UIRefreshControl while its screen sits off-window behind a
// tab or a pushed screen, and iOS leaves it stuck on screen when that happens.
// For the same reason, a pulled sync that settles while the screen is unfocused
// keeps the spinner until the screen is focused again.
export function useManualSyncRefresh(): ManualSyncRefresh {
  const isFocused = useIsFocused();
  const [syncing, setSyncing] = useState(false);
  const [refreshingWhenBlurred, setRefreshingWhenBlurred] = useState(false);

  if (isFocused && refreshingWhenBlurred !== syncing) {
    setRefreshingWhenBlurred(syncing);
  }

  const onRefresh = useCallback((): void => {
    setSyncing(true);
    requestSync('manual').finally(() => setSyncing(false));
  }, []);

  return { refreshing: isFocused ? syncing : refreshingWhenBlurred, onRefresh };
}
