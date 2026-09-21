import { Alert } from 'react-native';
import { safeHaptics } from './utils';

type ConfirmCallback = () => void | Promise<void>;

function runConfirm(callback: ConfirmCallback): void {
  Promise.resolve(callback()).catch(() => {});
}

export function confirmDestructive(
  title: string,
  message: string,
  onConfirm: ConfirmCallback,
  options?: { destructiveLabel?: string },
): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: options?.destructiveLabel ?? 'Delete',
      style: 'destructive',
      onPress: () => {
        runConfirm(onConfirm);
      },
    },
  ]);
}

// Shared by the Account and Profile screens so both Delete Account entry
// points keep identical copy and error handling (App Store 5.1.1(v)).
export function confirmAccountDeletion(deleteAccount: () => Promise<void>): void {
  confirmDestructive(
    'Delete Account',
    'This permanently deletes your OpenWhispr account and personal cloud data. Notes in shared spaces stay with your team. Local notes on this device stay here unless you delete the app.',
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
