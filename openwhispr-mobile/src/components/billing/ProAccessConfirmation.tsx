import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import type { SuperwallPurchaseCompletion } from '@/hooks/useSuperwallGate';

type Props = {
  completion: SuperwallPurchaseCompletion | null;
  onConsumed: () => void;
};

const COPY: Record<
  SuperwallPurchaseCompletion,
  { readonly title: string; readonly message: string }
> = {
  purchased: {
    title: 'Welcome to OpenWhispr Pro',
    message: 'Your purchase was successful. Pro features are ready to use.',
  },
  restored: {
    title: 'OpenWhispr Pro Restored',
    message: 'Your subscription was restored. Pro features are ready to use.',
  },
};

export function ProAccessConfirmation({ completion, onConsumed }: Props): null {
  const shownCompletionRef = useRef<SuperwallPurchaseCompletion | null>(null);

  useEffect(() => {
    if (!completion || shownCompletionRef.current === completion) return;

    shownCompletionRef.current = completion;
    onConsumed();
    const copy = COPY[completion];
    Alert.alert(copy.title, copy.message, [{ text: 'Start using Pro' }]);
  }, [completion, onConsumed]);

  return null;
}
