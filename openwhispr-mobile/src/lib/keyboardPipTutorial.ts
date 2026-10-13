import { PipTutorial, type PipStartOutcome } from '../../modules/pip-tutorial/src';
import { Sentry } from '@/lib/sentry';

// The bundled clip that walks through Settings ▸ Keyboards. Both the onboarding
// install step and the Full Access recovery screen play it, because both send the
// user somewhere we cannot follow them.
const KEYBOARD_INSTALL_VIDEO = 'keyboard-install';

// PiP preparation occasionally hangs on the native side. The tutorial is a nicety
// and the Settings hand-off behind it is not, so cap the wait rather than letting
// a stalled start block the thing the user actually asked for.
const START_TIMEOUT_MS = 2500;

type PipFailure = Exclude<PipStartOutcome, 'started'> | 'js_timeout';

// A newer start or a stop replaced this one, or the device has no PiP: nothing went wrong.
const EXPECTED_OUTCOMES: ReadonlySet<PipFailure> = new Set(['stopped', 'unsupported']);

// The user heads into Settings either way, so a failed start is invisible to them; report it.
function reportFailedStart(outcome: PipFailure): void {
  if (EXPECTED_OUTCOMES.has(outcome)) return;
  Sentry.captureMessage('Keyboard PiP tutorial did not start', {
    level: 'warning',
    tags: { pipOutcome: outcome.split(':')[0] },
    extra: { outcome },
  });
}

/** Resolves false (never rejects) when PiP is unsupported, unbundled, or slow. */
export async function startKeyboardPipTutorial(): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const outcome = await Promise.race([
      PipTutorial.start(KEYBOARD_INSTALL_VIDEO),
      new Promise<'js_timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('js_timeout'), START_TIMEOUT_MS);
      }),
    ]);
    if (outcome === 'started') return true;
    reportFailedStart(outcome);
    return false;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function stopKeyboardPipTutorial(): void {
  PipTutorial.stop().catch(() => undefined);
}
