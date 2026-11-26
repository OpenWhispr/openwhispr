import {
  noteSharingMessages,
  type NoteSharingFeedbackCode,
} from '@/android/lib/notes/noteSharingMessages';
export { noteSharingMessages as noteSharingFeedback } from '@/android/lib/notes/noteSharingMessages';
export type { NoteSharingFeedbackCode } from '@/android/lib/notes/noteSharingMessages';

/** English message preserves existing non-Android consumers; Android translates the code. */
export class NoteSharingError extends Error {
  constructor(readonly code: NoteSharingFeedbackCode) {
    super(noteSharingMessages[code]);
    this.name = 'NoteSharingError';
  }
}
