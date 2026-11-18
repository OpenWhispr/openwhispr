import { createRealtimeMeetingWs } from './createRealtimeMeetingWs';
import { createAndroidRealtimeRecovery } from '@/android/realtimeMeetingRecovery';
import {
  addPcmStopListener,
  addPcmErrorListener,
} from '../../../modules/live-pcm-streaming/src/index.android';

export type {
  WebSocketLike,
  RealtimeMeetingDeps,
  RealtimeTransportCallbacks as RealtimeCallbacks,
  RealtimeTransportSession as RealtimeSession,
} from './createRealtimeMeetingWs';
export type { RealtimeUtterance } from './realtimeEvents';

export const startRealtimeMeetingWs = createRealtimeMeetingWs((context) =>
  createAndroidRealtimeRecovery(context, { addPcmStopListener, addPcmErrorListener }),
);
