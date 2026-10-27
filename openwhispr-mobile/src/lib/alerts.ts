import { Alert, type AlertButton } from 'react-native';
import { safeHaptics } from './utils';

type ConfirmCallback = () => void | Promise<void>;

function runConfirm(callback: ConfirmCallback): void {
  Promise.resolve(callback()).catch(() => {});
}

export function confirmDestructive(
  title: string,
  // iOS draws an empty message as a blank line, so a title-only alert leaves it undefined.
  message: string | undefined,
  onConfirm: ConfirmCallback,
  options?: { destructiveLabel?: string; onCancel?: () => void },
): void {
  const onCancel = options?.onCancel;
  const buttons: AlertButton[] = [
    { text: 'Cancel', style: 'cancel', onPress: onCancel },
    {
      text: options?.destructiveLabel ?? 'Delete',
      style: 'destructive',
      onPress: () => {
        runConfirm(onConfirm);
      },
    },
  ];
  // Android reports a tap outside the dialog or Back through onDismiss, not the Cancel button.
  if (onCancel) Alert.alert(title, message, buttons, { cancelable: true, onDismiss: onCancel });
  else Alert.alert(title, message, buttons);
}

// Shared by the Account and Profile screens so both Delete Account entry
// points keep identical copy and error handling (App Store 5.1.1(v)).
export function confirmAccountDeletion(deleteAccount: () => Promise<void>): void {
  confirmDestructive(
    'Delete Account',
    'This permanently deletes your OpenWhispr account and personal cloud data, and removes provider keys saved on this device. Notes in shared spaces stay with your team. Local notes on this device stay here unless you delete the app.',
    async () => {
      try {
        await deleteAccount();
        safeHaptics('warning');
      } catch (error) {
        Alert.alert(
          'Delete Failed',
          error instanceof Error ? error.message : 'Unable to delete account.',
        );
      }
    },
    { destructiveLabel: 'Delete Account' },
  );
}

export function confirmCloudOnce(message: string, onConfirm: ConfirmCallback): void {
  Alert.alert('Use cloud AI?', message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Use Cloud Once',
      onPress: () => {
        runConfirm(onConfirm);
      },
    },
  ]);
}
