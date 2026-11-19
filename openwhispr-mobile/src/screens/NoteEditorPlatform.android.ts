import type { MutableRefObject } from 'react';
import type { Note } from '@/data/types';
import type { AuthUser } from '@/lib/authClient';
import type { ProcessingMode } from '@/types';

export type EditorCopy = (
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
) => string;
export interface EditorContext {
  noteId: number;
  note: Note | null;
  user: AuthUser | null;
  sessionCookie: string | null | undefined;
  activeMode: ProcessingMode;
  getNoteById: (id: number) => Note | null;
}
export interface EditorLifecycle {
  aiContext: unknown;
  editorActive: MutableRefObject<boolean>;
  editorGeneration: MutableRefObject<number>;
  chatConsentGeneration: MutableRefObject<number>;
  captureAIContext: () => () => boolean;
}
export interface NoteEditorPlatform {
  usePresentation: () => {
    copy: EditorCopy;
    copyRef: MutableRefObject<EditorCopy>;
    language: string;
    incompleteTranscript: () => string;
  };
  useSessionCookie: () => string | null | undefined;
  useLifecycle: (context: EditorContext) => EditorLifecycle;
  useActionCleanup: (context: unknown, cancel?: () => void) => void;
  useEditorFocus: (lifecycle: EditorLifecycle) => void;
  supportsVoiceEnrollment: () => boolean;
  showActionError: (message: string, error: unknown, copy: EditorCopy) => void;
}
