/**
 * Files that still read a colour outside render (see `themeAtRenderGuard.test.ts`), grouped by
 * the dark theme segment that moves them to `useTheme()` / `makeStyles()`. Take a file off when
 * it's clean; the guard fails on an entry that no longer needs to be here.
 */
export const PENDING: string[] = [
  // 7 · Account flows
  'src/android/auth/VerifyLinkScreen.tsx',
  'src/android/auth/look.tsx',
  'src/android/launch/LaunchScreens.tsx',
  // Shared (move with the first segment that needs them: controls, ui, the .android components, colors.android)
  'src/android/ui.tsx',
  'src/components/ui/Fab.android.tsx',
  'src/components/ui/FabCore.android.tsx',
  'src/components/ui/FormSheetCore.android.tsx',
  'src/components/ui/SwipeableCardCore.android.tsx',
  'src/config/colors.android.ts',
  // Found once the guard walked every src/components/**/*.android.* override: module-level
  // StyleSheets (layout only in MarkdownRenderer and VoiceprintSuggestionSheet; the rename sheet's
  // scrim is a colour).
  'src/components/notes/MarkdownRenderer.android.tsx',
  'src/components/notes/VoiceprintSuggestionSheet.android.tsx',
  'src/components/notes/speakerRenameLayout.android.ts',
];
