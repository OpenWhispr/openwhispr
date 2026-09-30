import { router, type Href } from 'expo-router';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';

type GlassBackButtonProps = {
  /** Where to go when there's no screen in the stack to pop back to. */
  fallbackRoute?: Href;
};

/** Standard glass-capsule back button for the app's custom headers. */
export function GlassBackButton({ fallbackRoute }: GlassBackButtonProps) {
  return (
    <GlassIconButton
      accessibilityLabel="Back"
      onPress={() => {
        safeHaptics('selection');
        if (router.canGoBack()) {
          router.back();
        } else if (fallbackRoute) {
          router.replace(fallbackRoute);
        }
      }}
    >
      <SystemIcon name="chevron.left" mdName="ChevronLeft" size={22} color="brand" />
    </GlassIconButton>
  );
}
