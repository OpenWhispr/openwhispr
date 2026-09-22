import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface BackgroundUploadOptions {
  url: string;
  fileUri: string;
  fileFieldName?: string;
  fileMimeType?: string;
  fileName?: string;
  parameters?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  routeSnapshot?: string;
}

export interface BackgroundUploadResult {
  status: number;
  body: string;
  uploadMs?: number;
  bodyBuildMs?: number;
}

export interface ProviderRequestOptions {
  requestId: string;
  routeSnapshot?: string;
  recoveryAudioUri?: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  fileUri?: string;
  fileFieldName?: string;
  fileMimeType?: string;
  fileName?: string;
  parameters?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface ProviderRequestResult {
  status: number;
  body: string;
  url: string;
  headers: Record<string, string>;
}

interface NativeBackgroundUploader {
  listProviderRecoveryJobIds?(): string[];
  clearProviderRecovery?(jobId: string): void;
  requestProvider(options: ProviderRequestOptions): Promise<ProviderRequestResult>;
  cancelProviderRequest(requestId: string): void;
  upload(options: {
    url: string;
    fileUri: string;
    fileFieldName: string;
    fileMimeType: string;
    fileName?: string;
    parameters: Record<string, string>;
    headers: Record<string, string>;
    timeoutSeconds?: number;
    routeSnapshot?: string;
  }): Promise<BackgroundUploadResult>;
}

const NativeModule: NativeBackgroundUploader | null =
  Platform.OS === 'ios' ? requireNativeModule('BackgroundUploader') : null;

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
      throw new Error('Provider requests require an updated iOS native build');
    return NativeModule.requestProvider(options);
  },

  cancelProviderRequest(requestId: string): void {
    NativeModule?.cancelProviderRequest?.(requestId);
  },

  isAvailable(): boolean {
    return NativeModule !== null;
  },

  async upload(options: BackgroundUploadOptions): Promise<BackgroundUploadResult> {
    if (!NativeModule) {
      throw new Error('BackgroundUploader is only available on iOS');
    }
    return NativeModule.upload({
      url: options.url,
      fileUri: options.fileUri,
      fileFieldName: options.fileFieldName ?? 'file',
      fileMimeType: options.fileMimeType ?? 'application/octet-stream',
      fileName: options.fileName,
      parameters: options.parameters ?? {},
      headers: options.headers ?? {},
      timeoutSeconds: options.timeoutSeconds,
      routeSnapshot: options.routeSnapshot,
    });
  },
};
