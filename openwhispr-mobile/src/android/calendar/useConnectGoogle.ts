import { useState } from 'react';
import { showToast } from '../settings/kit';
import { notesT } from '../notes/strings';
import { connectGoogleCalendar, type ConnectOptions } from './connect';

/** Connect from either place (Notes C1, Settings 19.2), with the toasts the design gives. */
export function useConnectGoogle({ aboveTabBar = false }: { aboveTabBar?: boolean } = {}) {
  const options = { aboveTabBar };
  const [connecting, setConnecting] = useState(false);
  return {
    connecting,
    // Google's sheet sits over the app and is closed there; this only resets the card.
    cancel: () => setConnecting(false),
    async connect(connectOptions: ConnectOptions = {}) {
      if (connecting) return;
      setConnecting(true);
      let existed = false;
      const outcome = await connectGoogleCalendar({
        ...connectOptions,
        onConnected: (accountId, wasConnected) => {
          existed = wasConnected;
          connectOptions.onConnected?.(accountId, wasConnected);
        },
      });
      setConnecting(false);
      // Adding an account that's already here just opens it (20.2); no toast for that.
      if (outcome === 'connected' && existed && !connectOptions.account) return;
      if (outcome === 'connected')
        showToast(notesT('calendarConnected'), 'success', undefined, options);
      else if (outcome === 'unavailable')
        showToast(notesT('calendarNotSetUp'), 'neutral', undefined, options);
      else if (outcome === 'signedOut')
        showToast(notesT('calendarSignIn'), 'neutral', undefined, options);
      else if (outcome === 'failed')
        showToast(notesT('calendarFailed'), 'error', undefined, options);
    },
  };
}
