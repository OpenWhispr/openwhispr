import { createInferenceRouting } from './inferenceRoutingCore';
import { androidRoutingPolicy } from '../android/routingPolicy';
export type { ProviderRoute, TranscriptionJobRoute } from './inferenceRoutingCore';

export const {
  getInferenceSelection,
  getPickedLocalModel,
  getTranscriptionProvider,
  resolveMobileProviderRoute,
  snapshotTextInference,
  snapshotTranscriptionJob,
} = createInferenceRouting(androidRoutingPolicy);
