import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createSnippetsView } from './SnippetsViewCore.android';

export const SnippetsView = createSnippetsView(useAndroidCopy);
