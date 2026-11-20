import type { InferenceRoutingPolicy } from '../lib/inferenceRoutingCore';

export const androidRoutingPolicy: InferenceRoutingPolicy = {
  privateUploadsStayLocal: true,
  localTextUsesCloudAccess: false,
  // A transcript made on the phone is cleaned up, or given to the Assistant, where that task is set
  // to run (Processing v2: every task chooses its own engine). With nothing saved it stays on the
  // phone (an unsaved Assistant follows cleanup's route; see bubbleRoute in pipeline.ts).
  keepTextLocal: (_scope, selection) => !selection || selection.mode === 'local',
};
