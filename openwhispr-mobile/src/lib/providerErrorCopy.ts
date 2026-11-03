import type { ProviderExecutionError } from '@/services/providers/ProviderExecutionError';

const PROVIDER_FAILURE_COPY: Readonly<Partial<Record<string, string>>> = {
  INVALID_CREDENTIAL: 'invalidCredential',
  PROVIDER_QUOTA_EXCEEDED: 'quotaProblem',
  MODEL_NOT_FOUND: 'modelNotFound',
  PROVIDER_RATE_LIMITED: 'rateLimited',
  PROVIDER_UNAVAILABLE: 'providerUnavailable',
  PROVIDER_REQUEST_FAILED: 'providerRequestFailed',
  PROVIDER_UNSUPPORTED: 'providerUnsupported',
  ENDPOINT_INVALID: 'endpointInvalid',
  CREDENTIAL_MISSING: 'credentialNeeded',
  CREDENTIAL_MISMATCH: 'credentialMismatch',
  REDIRECT_BLOCKED: 'redirectBlocked',
  PROVIDER_CERTIFICATE_UNTRUSTED: 'certificateUntrusted',
  PROVIDER_TIMED_OUT: 'providerTimeout',
  PROVIDER_LOCAL_NETWORK_ERROR: 'localNetwork',
  PROVIDER_NETWORK_ERROR: 'providerNetwork',
  PROVIDER_TRANSPORT_UNAVAILABLE: 'updateApp',
  PROVIDER_RESPONSE_INVALID: 'invalidResponse',
  PROVIDER_RESPONSE_TRUNCATED: 'truncatedResponse',
};

export function getProviderErrorCopyKey(
  error: Pick<ProviderExecutionError, 'code' | 'status'>,
): string | undefined {
  if (error.code === 'PROVIDER_REQUEST_FAILED' && !Number.isInteger(error.status)) return;
  const key = PROVIDER_FAILURE_COPY[error.code];
  return key ? `workflowSettings.${key}` : undefined;
}
