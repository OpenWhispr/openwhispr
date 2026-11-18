import { createInferenceRouting } from './inferenceRoutingCore';
export type { ProviderRoute, TranscriptionJobRoute } from './inferenceRoutingCore';

export const {
  getInferenceSelection,
  getPickedLocalModel,
  getTranscriptionProvider,
  resolveMobileProviderRoute,
  snapshotTextInference,
  snapshotTranscriptionJob,
} = createInferenceRouting();
