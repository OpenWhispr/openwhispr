import { createRealtimeMeetingWs } from '@/android/transcription/createRealtimeMeetingWs';
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
} from '@/android/transcription/createRealtimeMeetingWs';
export type { RealtimeUtterance } from '@/android/shared/services/transcription/realtimeEvents';

export const startRealtimeMeetingWs = createRealtimeMeetingWs((context) =>
  createAndroidRealtimeRecovery(context, { addPcmStopListener, addPcmErrorListener }),
);
