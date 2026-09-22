import { PipTutorial } from '../../modules/pip-tutorial/src';

// The bundled clip that walks through Settings ▸ Keyboards. Both the onboarding
// install step and the Full Access recovery screen play it, because both send the
// user somewhere we cannot follow them.
const KEYBOARD_INSTALL_VIDEO = 'keyboard-install';

// PiP preparation occasionally hangs on the native side. The tutorial is a nicety
// and the Settings hand-off behind it is not, so cap the wait rather than letting
// a stalled start block the thing the user actually asked for.
const START_TIMEOUT_MS = 2500;

/** Resolves false (never rejects) when PiP is unsupported, unbundled, or slow. */
export async function startKeyboardPipTutorial(): Promise<boolean> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      PipTutorial.start(KEYBOARD_INSTALL_VIDEO),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), START_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function stopKeyboardPipTutorial(): void {
  PipTutorial.stop().catch(() => undefined);
}
