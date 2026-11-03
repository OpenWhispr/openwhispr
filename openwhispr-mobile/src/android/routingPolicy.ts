import type { InferenceRoutingPolicy } from '../lib/inferenceRoutingCore';

export const androidRoutingPolicy: InferenceRoutingPolicy = {
  privateUploadsStayLocal: true,
  localTextUsesCloudAccess: false,
  keepTextLocal: (scope, selection) => !(scope === 'cleanup' && selection?.mode === 'providers'),
};
