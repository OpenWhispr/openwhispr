/** App-owned sharing feedback. Keep identity separate from provider-supplied text. */
export const noteSharingFeedback = {
  invalidEmail: 'Enter a valid email address.',
  generic: 'Unable to update sharing. Please try again.',
  policy: 'Sharing is restricted by your organization.',
  denied: 'You do not have permission to manage sharing for this note.',
  sso: 'Sign in with your company SSO to manage sharing.',
  archived: 'This note is in an archived space.',
  verifyEmail: 'Verify your email before inviting people.',
  dailyLimit: 'You have reached today’s invitation limit. Try again tomorrow.',
  cooldown: 'Please wait a minute before resending.',
  sessionExpired: 'Your session has expired. Sign in again to manage sharing.',
  settingsChanged: 'Sharing settings changed. Refresh and try again.',
  connection: 'Can’t reach OpenWhispr. Check your connection and try again.',
  loadTimeout: 'Sharing settings timed out. Check your connection and retry.',
  operationTimeout: 'Sharing timed out. Refresh settings to check whether the change completed.',
  contextChanged: 'Sharing cancelled because the account or note changed.',
  signIn: 'Sign in to an account to share notes.',
  syncFirst: 'Sync this note before sharing.',
  unconfirmed: 'The sharing change could not be confirmed. Refresh settings before trying again.',
  accessLost: 'Sharing changed. You can no longer manage sharing for this note.',
  reloadFailed:
    'Sharing changed, but the updated settings could not be loaded. Refresh to continue.',
  reviewSettings: 'Sharing settings changed. Review them and try again.',
  linkReplaced:
    'New link copied. The previous link, including links in invitation emails, no longer works.',
  linkUnavailable:
    'The link is unavailable on this device. Choose Replace link to create a new one.',
  linkCopied: 'Link copied.',
  alreadyInvited: 'This person already has access or an invitation.',
  accessGranted: 'Access granted.',
  emailNotSent: 'Access granted, but the invitation email was not sent. Use Resend to try again.',
  groupDenied: 'You do not have permission to manage group access.',
  accessChanged: 'Access changed. Refresh and try again.',
  inheritedManaged: 'Inherited access is managed in its team or space.',
  inheritedDenied: 'You do not have permission to change inherited access.',
  sendFailed: 'The invitation email could not be sent. Try again later.',
  invitationSent: 'Invitation sent.',
  noteUnavailable: 'This note is no longer available.',
  notePrivate: 'Enable cloud sync for this note before sharing.',
  syncConflict: 'Resolve this note’s sync conflict before sharing.',
  signInBefore: 'Sign in to an account before sharing.',
  cancelled: 'Sharing cancelled.',
  syncPending: 'The note has not finished syncing. Check your connection and try again.',
  accountChanged: 'Your account changed. Open sharing again.',
  noteChanged: 'This note’s cloud identity changed. Open sharing again.',
  backupDisabled: 'Turn on Cloud Backup in Account → Privacy & Data before sharing.',
  syncRejected: 'The latest changes were rejected by sync. Edit the note and retry before sharing.',
  offline: 'You’re offline. Connect to the internet to share this note.',
  backupPolicy: 'Your organization does not allow cloud backup.',
  syncConnection: 'Unable to sync this note. Check your connection and try again.',
  subscription: 'An active subscription is required to sync this note.',
  spacePending: 'This note’s space is not available to sync yet. Try again later.',
  folderPending: 'This note’s folder has not synced yet. Try again later.',
  syncFailed: 'Unable to sync this note.',
} as const;

export type NoteSharingFeedbackCode = keyof typeof noteSharingFeedback;

/** English message preserves existing non-Android consumers; Android translates the code. */
export class NoteSharingError extends Error {
  constructor(readonly code: NoteSharingFeedbackCode) {
    super(noteSharingFeedback[code]);
    this.name = 'NoteSharingError';
  }
}
