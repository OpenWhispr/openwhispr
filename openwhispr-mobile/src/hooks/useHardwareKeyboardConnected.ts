import { useEffect, useState } from 'react';
import {
  AppGroupStorage,
  addHardwareKeyboardChangedListener,
} from '../../modules/app-group-storage/src';

export function useHardwareKeyboardConnected(): boolean {
  const [connected, setConnected] = useState(() => AppGroupStorage.isHardwareKeyboardConnected());

  useEffect(() => {
    const subscription = addHardwareKeyboardChangedListener(({ connected: next }) =>
      setConnected(next),
    );
    return () => subscription?.remove();
  }, []);

  return connected;
}
