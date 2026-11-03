import { confirmDestructive } from './alerts';
import type { SnippetCloseOptions } from './snippetClose';

export function createSnippetCloseHandler({
  onClose,
  initial,
  trigger,
  replacement,
  copy,
}: SnippetCloseOptions): () => void | boolean {
  return () => {
    if (trigger === (initial?.trigger ?? '') && replacement === (initial?.replacement ?? '')) {
      onClose();
      return;
    }
    confirmDestructive(
      copy('library.discardTitle', 'Discard changes?'),
      copy('library.discardBody', 'Your snippet changes have not been saved.'),
      onClose,
      {
        destructiveLabel: copy('library.discard', 'Discard'),
        cancelLabel: copy('cancel', 'Cancel'),
      },
    );
    return false;
  };
}
