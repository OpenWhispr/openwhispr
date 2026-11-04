import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createSnippetsView } from './SnippetsViewCore';

export const SnippetsView = createSnippetsView(useAndroidCopy);
