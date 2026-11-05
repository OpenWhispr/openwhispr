import type { useAndroidCopy } from '@/hooks/useAndroidCopy';
import type { Snippet } from './snippets';

export type SnippetCloseOptions = {
  onClose: () => void;
  initial?: Pick<Snippet, 'trigger' | 'replacement'> | null;
  trigger: string;
  replacement: string;
  copy: ReturnType<typeof useAndroidCopy>['copy'];
};

export function createSnippetCloseHandler({ onClose }: SnippetCloseOptions): () => void {
  return onClose;
}
