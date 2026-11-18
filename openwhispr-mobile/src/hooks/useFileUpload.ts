import { useFileUploadCore, type UseFileUploadOptions } from './useFileUploadCore';
export type { UseFileUploadOptions } from './useFileUploadCore';

function useDefaultLifecycle() {
  return undefined;
}

export function useFileUpload(options: UseFileUploadOptions = {}) {
  const { upload } = useFileUploadCore(options, useDefaultLifecycle, (text) =>
    options.onComplete?.(text),
  );
  return {
    isProcessing: upload.isProcessing,
    currentText: upload.currentText,
    pickAndTranscribeFile: () => upload.pickAndTranscribeFile(),
  };
}
