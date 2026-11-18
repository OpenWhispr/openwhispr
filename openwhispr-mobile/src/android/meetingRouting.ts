/**
 * Meetings set to run on the phone (Processing → Meetings → On device): recorded here and
 * transcribed afterwards, with speaker names. Kept apart from the live-meeting clients so the
 * meeting store can ask without loading them.
 */
export function meetingOnDevice(): boolean {
  const { useConfigStore } =
    require('@/store/useConfigStore') as typeof import('@/store/useConfigStore');
  return useConfigStore.getState().config?.inference?.meeting?.mode === 'local';
}
