/**
 * Every local model download and delete ends here, Parakeet and Whisper alike: which models are
 * on disk decides the engine Local Mode resolves to, and the keyboard's snapshot must follow it
 * while the app stays open.
 */
export function refreshKeyboardEngine(): void {
  // Required lazily: keyboardLocalEngine imports LocalTranscriptionService, which imports the
  // model services that call this.
  const { refreshKeyboardLocalEngine } =
    require('@/lib/keyboardLocalEngine') as typeof import('@/lib/keyboardLocalEngine');
  refreshKeyboardLocalEngine().catch(() => {});
}
