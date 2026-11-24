/**
 * Files that still read a colour outside render (see `themeAtRenderGuard.test.ts`), grouped by
 * the dark theme segment that moves them to `useTheme()` / `makeStyles()`. Take a file off when
 * it's clean; the guard fails on an entry that no longer needs to be here.
 */
export const PENDING: string[] = [
  // 3 · Dictionary
  'src/android/dictionary/DictionaryRoot.tsx',
  'src/android/dictionary/Empty.tsx',
  'src/android/dictionary/Field.tsx',
  'src/android/dictionary/FixWord.tsx',
  'src/android/dictionary/ReviewStack.tsx',
  'src/android/dictionary/sheets.tsx',
  // 4 · Style
  'src/android/StyleScreen.tsx',
  'src/android/style/ToneSetupScreen.tsx',
  'src/android/style/kit.tsx',
  // 5 · Settings
  'src/android/LanguageSheet.tsx',
  'src/android/processingFable/AddKeySheet.tsx',
  'src/android/processingFable/CheckPhoneScreen.tsx',
  'src/android/processingFable/ProcessingScreen.tsx',
  'src/android/processingFable/TaskSheet.tsx',
  'src/android/processingFable/look.tsx',
  'src/android/processingFable/ui.tsx',
  'src/android/settings/BubbleAssistantScreen.tsx',
  'src/android/settings/CalendarScreen.tsx',
  'src/android/settings/CleanupPromptScreen.tsx',
  'src/android/settings/DownloadRing.tsx',
  'src/android/settings/KeyCheckMark.tsx',
  'src/android/settings/KeySheet.tsx',
  'src/android/settings/ModelListRow.tsx',
  'src/android/settings/ModelRow.tsx',
  'src/android/settings/ModelScreen.tsx',
  'src/android/settings/ProcessingScreen.tsx',
  'src/android/settings/SizeLookScreen.tsx',
  'src/android/settings/TaskScreen.tsx',
  'src/android/settings/calendarParts.tsx',
  'src/android/settings/kit.tsx',
  'src/android/settings/look.ts',
  'src/components/ui/SettingsSection.android.tsx',
  'src/android/DeviceCheckScreen.tsx',
  'src/android/PlanContent.tsx',
  'src/android/settings/PermissionsScreen.tsx',
  'src/screens/LicensesScreen.android.tsx',
  'src/screens/PrivacyDataScreen.android.tsx',
  'src/screens/ReferralScreen.android.tsx',
  'src/screens/TranscriptionLanguageScreen.android.tsx',
  // 6 · Onboarding + bubble
  'src/android/Practice.tsx',
  'src/android/onboarding/AppsScreen.tsx',
  'src/android/onboarding/DeviceSetupScreens.tsx',
  'src/android/onboarding/EndScreens.tsx',
  'src/android/onboarding/IntroScreens.tsx',
  'src/android/onboarding/LanguagesScreen.tsx',
  'src/android/onboarding/PermissionScreens.tsx',
  'src/android/onboarding/PracticeBubble.tsx',
  'src/android/onboarding/PracticeMenuScreen.tsx',
  'src/android/onboarding/PracticeScreen.tsx',
  'src/android/onboarding/kit.tsx',
  'src/android/onboarding/practiceParts.tsx',
  // 7 · Account flows
  'src/android/auth/VerifyLinkScreen.tsx',
  'src/android/auth/look.tsx',
  'src/android/launch/LaunchScreens.tsx',
  'src/screens/AccountScreen.android.tsx',
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
