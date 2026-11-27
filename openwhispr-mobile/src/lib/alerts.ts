import { Alert, Platform, type AlertButton } from 'react-native';
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

// Capture keeps writing into the note and Stop links its recording to it, so a deleted note would
// end up with audio uploaded for a row nobody can see.
export function alertMeetingNoteNotDeletable(): void {
  Alert.alert('Meeting in progress', 'End the meeting before deleting its note.');
}

// The meeting ended as soon as its recording was refused, so this is the only place the user
// learns why the screen went back to the start.
export function alertMeetingStartFailed(message: string): void {
  Alert.alert("Recording didn't start", message);
}

// Retry found no connection: nothing was uploaded, and the note now says it is waiting, so the
// user isn't left watching an upload that could only time out.
export function alertMeetingWaitingForConnection(): void {
  Alert.alert("You're offline", "This meeting will be transcribed when you're back online.");
}

// The store keeps renewing a subscription after the account behind it is gone,
// and the server cannot cancel it, so the user has to before deleting.
function storeSubscriptionWarning(): string {
  return Platform.OS === 'android'
    ? 'Deleting your account does not cancel a subscription bought through Google Play. Cancel it first in Google Play → Payments & subscriptions → Subscriptions.'
    : 'Deleting your account does not cancel a subscription bought through the App Store. Cancel it first in Settings → your name → Subscriptions.';
}

// Shared by the Account and Profile screens so both Delete Account entry
// points keep identical copy and error handling (App Store 5.1.1(v)).
export function confirmAccountDeletion(deleteAccount: () => Promise<void>): void {
  confirmDestructive(
    'Delete Account',
    'This permanently deletes your OpenWhispr account and personal cloud data, and removes provider keys saved on this device. Notes in shared spaces stay with your team. Local notes on this device stay here unless you delete the app.\n\n' +
      storeSubscriptionWarning(),
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
