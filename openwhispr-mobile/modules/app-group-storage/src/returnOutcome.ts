/** What happened when OpenWhispr tried to send the user back to the keyboard's host app. */
export type ReturnOutcome =
  | { status: 'opened'; hostName: string | null }
  | { status: 'failed'; hostName: string | null }
  | { status: 'no_target' }
  | { status: 'skipped' };

export const NO_RETURN_TARGET: ReturnOutcome = { status: 'no_target' };

export function parseReturnOutcome(raw: unknown): ReturnOutcome {
  if (!raw || typeof raw !== 'object') return NO_RETURN_TARGET;
  const { status, hostName } = raw as { status?: unknown; hostName?: unknown };
  const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : null;
  switch (status) {
    case 'opened':
    case 'failed':
      return { status, hostName: name };
    case 'skipped':
      return { status: 'skipped' };
    default:
      return NO_RETURN_TARGET;
  }
}
