import { useCallback, useEffect, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import {
  captureTranscriptScope,
  isTranscriptScopeCurrent,
  observeTranscriptScope,
} from '@/lib/transcriptScope';
import { snapshotTranscriptionJob } from '../lib/inferenceRouting';
import { isNoSpeechError } from '../lib/permissions';
import { toFriendlyTranscriptionErrorMessage } from '../lib/transcriptionErrors';
import type { TranscriptionProvider } from '../types';
import type {
  CommonFileUploadOptions,
  FileUploadLifecycle,
  FileUploadState,
} from '../hooks/useFileUploadCore';

export interface AndroidFileUploadOptions extends CommonFileUploadOptions {
  onComplete?: (text: string, fileName: string) => void;
  saveToHistory?: boolean;
  isCurrent?: () => boolean;
}

export function useAndroidFileUploadLifecycle(
  options: AndroidFileUploadOptions,
  { setIsProcessing, setCurrentText }: FileUploadState,
): FileUploadLifecycle {
  const [stage, setStage] = useState<'transcribing' | 'cleaning'>('transcribing');
  const active = useRef<{ controller: AbortController; provider: TranscriptionProvider } | null>(
    null,
  );
  const mounted = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const cancel = useCallback(() => {
    generation.current += 1;
    const job = active.current;
    job?.controller.abort();
    if (job?.provider === 'local') {
      import('../services/transcription/LocalTranscriptionService')
        .then(({ LocalTranscriptionService }) => {
          if (active.current === job) return LocalTranscriptionService.cancelTranscription();
        })
        .catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);
  useEffect(() => observeTranscriptScope(cancel), [cancel]);
  return {
    stage,
    cancel,
    allowsLocalOpus: true,
    failedIdentity: (clientTranscriptionId) => ({ clientTranscriptionId }),
    toFriendlyError: (error) => {
      const message = toFriendlyTranscriptionErrorMessage(error);
      return error instanceof Error && message === error.message ? error : new Error(message);
    },
    begin: () => {
      if (busy.current || !mounted.current || options.isCurrent?.() === false) return null;
      busy.current = true;
      const historyScope = captureTranscriptScope();
      const jobGeneration = ++generation.current;
      const isCurrent = () =>
        mounted.current &&
        generation.current === jobGeneration &&
        isTranscriptScopeCurrent(historyScope) &&
        options.isCurrent?.() !== false;
      const check = () => {
        if (!isCurrent())
          throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
      };
      setIsProcessing(true);
      let pickerCacheUri: string | undefined;
      return {
        snapshotRoute: (route) => route ?? snapshotTranscriptionJob('upload'),
        picked: (result) => {
          const pickedUri = result.canceled ? undefined : result.assets[0]?.uri;
          if (
            pickedUri &&
            FileSystem.cacheDirectory &&
            pickedUri.startsWith(FileSystem.cacheDirectory)
          )
            pickerCacheUri = pickedUri;
          check();
        },
        check,
        isCurrent,
        resetStage: () => setStage('transcribing'),
        saveToHistory: () => options.saveToHistory !== false,
        discardFailure: (error) =>
          !isCurrent() ||
          options.saveToHistory === false ||
          isNoSpeechError(error) ||
          (error as Error)?.name === 'AbortError',
        beginRequest: (provider) => {
          const controller = new AbortController();
          active.current = { controller, provider };
          return {
            options: {
              signal: controller.signal,
              shouldCancel: () => controller.signal.aborted || !isCurrent(),
              onRawTranscript: (text) => {
                if (isCurrent()) setCurrentText(text);
              },
              onStage: (next) => {
                if (isCurrent()) setStage(next);
              },
            },
            check: () => {
              check();
              if (controller.signal.aborted)
                throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
            },
            markError: (error) => {
              if (controller.signal.aborted && error instanceof Error) error.name = 'AbortError';
            },
            finish: () => {
              if (active.current?.controller === controller) active.current = null;
            },
          };
        },
        beginRetry: () => {
          if (!isCurrent() || active.current) return false;
          busy.current = true;
          return true;
        },
        finishRetry: () => {
          busy.current = false;
          if (mounted.current) setIsProcessing(false);
        },
        isAbort: (error) => (error as Error)?.name === 'AbortError',
        ignoreError: (error) => !isCurrent() || (error as Error)?.name === 'AbortError',
        finish: async () => {
          if (pickerCacheUri)
            await FileSystem.deleteAsync(pickerCacheUri, { idempotent: true }).catch(
              () => undefined,
            );
          busy.current = active.current !== null;
          if (mounted.current) setIsProcessing(busy.current);
        },
      };
    },
  };
}
