import { useState } from 'react';
import { showToast } from '../settings/kit';
import { notesT } from '../notes/strings';
import { cancelGoogleCalendarConnect, connectGoogleCalendar } from './connect';

/** Connect from either place (Notes C1, Settings 19.2), with the toasts the design gives. */
export function useConnectGoogle() {
  const [connecting, setConnecting] = useState(false);
  return {
    connecting,
    cancel: () => {
      cancelGoogleCalendarConnect();
      setConnecting(false);
    },
    async connect() {
      if (connecting) return;
      setConnecting(true);
      const outcome = await connectGoogleCalendar();
      setConnecting(false);
      if (outcome === 'connected') showToast(notesT('calendarConnected'), 'success');
      else if (outcome === 'unavailable') showToast(notesT('calendarNotSetUp'), 'neutral');
      else if (outcome === 'signedOut') showToast(notesT('calendarSignIn'), 'neutral');
      else if (outcome === 'failed') showToast(notesT('calendarFailed'), 'error');
    },
  };
}
