import { requireNativeModule } from 'expo';
import type {
  BackgroundUploadOptions,
  BackgroundUploadResult,
  ProviderRequestOptions,
  ProviderRequestResult,
} from './index';

export type {
  BackgroundUploadOptions,
  BackgroundUploadResult,
  ProviderRequestOptions,
  ProviderRequestResult,
} from './index';

const NativeModule = requireNativeModule<{
  listProviderRecoveryJobIds?(): string[];
  clearProviderRecovery?(jobId: string): void;
  requestProvider?(options: ProviderRequestOptions): Promise<ProviderRequestResult>;
  cancelProviderRequest?(requestId: string): void;
}>('AndroidDictation');

export const BackgroundUploader = {
  listProviderRecoveryJobIds(): string[] {
    return NativeModule?.listProviderRecoveryJobIds?.() ?? [];
  },

  clearProviderRecovery(jobId: string): boolean {
    if (!NativeModule?.clearProviderRecovery) return false;
    NativeModule.clearProviderRecovery(jobId);
    return true;
  },

  async requestProvider(options: ProviderRequestOptions): Promise<ProviderRequestResult> {
    if (!NativeModule?.requestProvider)
      throw Object.assign(new Error('Provider requests require an updated native build'), {
        code: 'PROVIDER_TRANSPORT_UNAVAILABLE',
      });
    return NativeModule.requestProvider(options);
  },

  cancelProviderRequest(requestId: string): void {
    NativeModule?.cancelProviderRequest?.(requestId);
  },

  isAvailable(): boolean {
    return false;
  },

  async upload(_options: BackgroundUploadOptions): Promise<BackgroundUploadResult> {
    throw new Error('BackgroundUploader is only available on iOS');
  },
};
