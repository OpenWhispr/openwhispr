import { noteSharingMessages, type NoteSharingFeedbackCode } from './noteSharingMessages';
export { noteSharingMessages as noteSharingFeedback } from './noteSharingMessages';
export type { NoteSharingFeedbackCode } from './noteSharingMessages';

/** English message preserves existing non-Android consumers; Android translates the code. */
export class NoteSharingError extends Error {
  constructor(readonly code: NoteSharingFeedbackCode) {
    super(noteSharingMessages[code]);
    this.name = 'NoteSharingError';
  }
}
