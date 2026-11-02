import { createRealtimeMeetingWs, type RealtimeMeetingDeps } from './createRealtimeMeetingWs';
import type { RealtimeCallbacks, RealtimeSession } from './realtimeEvents';

export type { WebSocketLike, RealtimeMeetingDeps } from './createRealtimeMeetingWs';
export type { RealtimeCallbacks, RealtimeSession, RealtimeUtterance } from './realtimeEvents';

const start = createRealtimeMeetingWs();

export function startRealtimeMeetingWs(
  opts: { language?: string; model?: string; sampleRate?: number } = {},
  callbacks: RealtimeCallbacks = {},
  deps: RealtimeMeetingDeps = {},
): Promise<RealtimeSession> {
  return start(opts, callbacks, deps);
}
