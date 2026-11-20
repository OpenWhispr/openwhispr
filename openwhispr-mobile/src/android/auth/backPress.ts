// The sign-in screen's own steps (Welcome back, Reset password, …) answer the system back
// gesture before whatever hosts the screen. Onboarding registers its handler after the screen
// mounts, so Android would ask it first; it asks this instead while its sign-in step is open.
let handler: (() => boolean) | null = null;

export function setAuthBackHandler(next: (() => boolean) | null): void {
  handler = next;
}

/** True when the sign-in screen used the back press itself. */
export function handleAuthBack(): boolean {
  return handler?.() ?? false;
}
