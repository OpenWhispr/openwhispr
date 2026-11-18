import {
  captureTranscriptScope,
  isTranscriptScopeCurrent,
  observeTranscriptScope,
} from '@/lib/transcriptScope';
import type { ProviderFileScope } from '@/services/providers/NativeProviderTransportCore';

export function createProviderFileScope(routeSnapshot?: string): ProviderFileScope {
  const scope = captureTranscriptScope();
  return {
    routeSnapshot:
      routeSnapshot && scope
        ? JSON.stringify({ ...JSON.parse(routeSnapshot), historyOwner: scope.key })
        : routeSnapshot,
    observe: observeTranscriptScope,
    isCurrent: () => isTranscriptScopeCurrent(scope),
  };
}
