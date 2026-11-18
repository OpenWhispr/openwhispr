import type { InferenceRoutingPolicy } from '../lib/inferenceRoutingCore';

export const androidRoutingPolicy: InferenceRoutingPolicy = {
  privateUploadsStayLocal: true,
  localTextUsesCloudAccess: false,
  // A transcript made on the phone is cleaned up where cleanup is set to run (Processing v2:
  // every task chooses its own engine). With nothing saved it stays on the phone.
  keepTextLocal: (scope, selection) =>
    scope !== 'cleanup' || !selection || selection.mode === 'local',
};
