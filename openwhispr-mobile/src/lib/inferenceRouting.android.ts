import { createInferenceRouting } from '@/android/lib/inferenceRoutingCore';
import { androidRoutingPolicy } from '../android/routingPolicy';
export type { ProviderRoute, TranscriptionJobRoute } from '@/android/lib/inferenceRoutingCore';

export const {
  getInferenceSelection,
  getPickedLocalModel,
  getTranscriptionProvider,
  resolveMobileProviderRoute,
  snapshotTextInference,
  snapshotTranscriptionJob,
} = createInferenceRouting(androidRoutingPolicy);
