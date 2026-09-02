const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dynamic prose and identity values keep their own direction", () => {
  const expectations = [
    [
      "src/components/dictation/LiveTranscriptPanel.tsx",
      /<p\s+dir="auto"[\s\S]*?\{shimmerParts\.settled\}/,
    ],
    ["src/components/ui/TranscriptionItem.tsx", /<p\s+dir="auto"[\s\S]*?\{item\.text\}/],
    ["src/components/ui/TranscriptionItem.tsx", /<p\s+dir="auto"[^>]*>\s*\{rawText\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{transcript\.text\}/],
    ["src/components/DictionaryView.tsx", /<span\s+dir="auto"[^>]*>\s*\{word\}/],
    ["src/components/SnippetsView.tsx", /<span\s+dir="auto"[^>]*>\s*\{snippet\.trigger\}/],
    ["src/components/SnippetsView.tsx", /<span\s+dir="auto"[^>]*>\s*\{snippet\.replacement\}/],
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayName\}\s*<\/span>/,
    ],
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{folder\.name\}\s*<\/span>/,
    ],
    ["src/components/notes/SpacesTree.tsx", /<span\s+dir="auto"[^>]*>\s*\{title\}\s*<\/span>/],
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*\s+title=\{workspace\.name\}[\s\S]*?\{workspace\.name\}/,
    ],
    ["src/components/EmailVerificationStep.tsx", /<span\s+dir="ltr"[^>]*>\s*\{email\}/],
    [
      "src/components/SettingsModal.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{user\.name \|\| t\("settingsPage\.account\.user"\)\}/,
    ],
    ["src/components/SettingsModal.tsx", /<p\s+dir="ltr"[^>]*>\s*\{user\.email\}/],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{member\.name \|\| member\.email\}/,
    ],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{request\.name \?\? request\.email\}/,
    ],
    ["src/components/settings/WorkspaceMembersTab.tsx", /<p\s+dir="ltr"[^>]*>\s*\{inv\.email\}/],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{downloadProgress\.title\}/,
    ],
    ["src/components/notes/UploadAudioView.tsx", /<span\s+dir="auto"[^>]*>\s*\{f\.name\}/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its content-direction policy`);
  }
});

test("technical output values remain LTR inside an Arabic document", () => {
  const expectations = [
    ["src/components/DeveloperSection.tsx", /<code\s+dir="ltr"[\s\S]*?\{logPath\}/],
    [
      "src/components/TestConnectionButton.tsx",
      /<code\s+dir="ltr"[^>]*>\s*\{errorInfo\.copyCommand\}/,
    ],
    ["src/components/ui/TechnicalErrorDetails.tsx", /<pre\s+dir="ltr"[\s\S]*?\{text\}/],
    ["src/components/ui/NixOsPasteInfo.tsx", /<div\s+dir="ltr"[\s\S]*?<pre/],
    ["src/components/McpIntegrationCard.tsx", /<span\s+dir="ltr"[\s\S]*?\{MCP_URL\}/],
    [
      "src/components/settings/WorkspaceBillingCard.tsx",
      /<span\s+dir="ltr"[^>]*>\s*\{seatsUsed\} \/ \{seatsTotal\}/,
    ],
    ["src/components/settings/WorkspaceMembersTab.tsx", /<p\s+dir="ltr"[^>]*>\s*\{member\.email\}/],
    [
      "src/components/dictation/AssistantPanel.tsx",
      /<kbd\s+dir="ltr"[\s\S]*?\{readableVoiceHotkey\}/,
    ],
    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.bedrockRegion\}/,
    ],
    [
      "src/components/EnterpriseProviderConfig.tsx",
      /<select\s+dir="ltr"\s+value=\{store\.vertexLocation\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*font-medium[^>]*>\s*\{file\.name\}/,
    ],
    [
      "src/components/notes/UploadAudioView.tsx",
      /<p\s+dir="ltr"[^>]*max-w-50[^>]*>\s*\{file\.name\}/,
    ],
    ["src/components/ui/SidebarModal.tsx", /<span\s+dir="ltr"[\s\S]*?v\{version\}/],
    ["src/components/onboarding/DemoStep.tsx", /<span\s+dir="ltr"[\s\S]*?\{assistantSenderEmail\}/],
    ["src/components/ui/ModelCardList.tsx", /<span\s+dir="ltr"[\s\S]*?\{model\.label\}/],
    [
      "src/components/onboarding/ProviderSetupStep.tsx",
      /<span\s+dir="ltr">\s*\{models\.find[\s\S]*?\?\? selectedModel\}/,
    ],
    [
      "src/components/onboarding/RequiredModelDownloadStep.tsx",
      /<span\s+dir="ltr"[\s\S]*?\{info\?\.name \?\? modelId\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its LTR technical-output isolation`);
  }
});

test("localized sentences isolate technical interpolations without changing word order", () => {
  const expectations = [
    [
      "src/components/ControlPanel.tsx",
      /<BidiInterpolatedText[\s\S]*?updateRequiredByOrg\.description[\s\S]*?value=\{policyMinAppVersion\}/,
    ],
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?hyprlandConfigWriteWarningDescription[\s\S]*?value=\{hyprlandConfigStatus\.path\}/,
    ],
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?resetToDefault[\s\S]*?value=\{formatHotkeyLabel\(effectiveDefaultHotkey\)\}/,
    ],
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?updates\.whatsNew[\s\S]*?value=\{updateInfo\.version\}/,
    ],
    [
      "src/components/TeamRosterSection.tsx",
      /<BidiInterpolatedText[\s\S]*?members\.inviteFooter[\s\S]*?value=\{addSearch\.trim\(\)\}/,
    ],
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?googleCalendar\.disconnectConfirm[\s\S]*?value=\{confirmDisconnectEmail\}/,
    ],
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?microsoftCalendar\.disconnectConfirm[\s\S]*?value=\{confirmMsDisconnectEmail\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    const text = source(file);
    assert.match(text, pattern, `${file} lost a bidi-isolated technical interpolation`);
    assert.match(text, /BIDI_VALUE_TOKEN/, `${file} must interpolate with the stable marker`);
  }
});

test("direction-sensitive transient motion mirrors in RTL", () => {
  assert.match(
    source("src/components/dictation/LiveTranscriptPanel.tsx"),
    /pointer-events-none translate-x-2 rtl:-translate-x-2 opacity-0/,
    "LiveTranscriptPanel controls must retreat toward the document end"
  );
});

test("user-authored names and previews detect direction at their display boundary", () => {
  const expectations = [
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{conv\.title\}/],
    [
      "src/components/CommandSearch.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{conv\.last_message\.slice\(0, 90\)\}/,
    ],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(scopeSpace\)\}/],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(space\)\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{target\.label\}/],
    ["src/components/chat/ConversationItem.tsx", /<p\s+dir="auto"[^>]*>\s*\{conversation\.title\}/],
    [
      "src/components/chat/ConversationItem.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{conversation\.preview\}/,
    ],
    ["src/components/chat/ChatMessage.tsx", /<p\s+dir="auto"[^>]*>\s*\{title\}/],
    ["src/components/DictionaryView.tsx", /<span\s+dir="auto"[^>]*>\s*\{agentName\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{speakerLabel\}/,
    ],
    ["src/components/notes/MeetingTranscriptChat.tsx", /<span\s+dir="auto"[^>]*>\s*\{text\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{segment\.suggestedName\}/,
    ],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayLabel\}/,
    ],
    ["src/components/notes/CreateSpaceDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{item\.name\}/],
    ["src/components/notes/CreateSpaceDialog.tsx", /<p\s+dir="auto"[^>]*>\s*\{workspace\.name\}/],
    ["src/components/notes/CreateSpaceDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{team\.name\}/],
    ["src/components/notes/SpaceMembersDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{teamRef\.name\}/],
    ["src/components/notes/SpaceMembersDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{team\.name\}/],
    [
      "src/components/settings/WorkspaceSection.tsx",
      /<h2\s+dir="auto"[^>]*>\s*\{workspace\.name\}/,
    ],
    ["src/components/settings/WorkspaceSection.tsx", /<span\s+dir="auto"[^>]*>\s*\{w\.name\}/],
    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{space\.name\}/],
    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{folderName\}/],
    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{folder\.name\}/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost a dynamic-content direction boundary`);
  }

  const meetingCards = source("src/components/UpcomingMeetings.tsx").match(
    /<p\s+dir="auto"[^>]*>\s*\{event\.summary \|\| t\("upcoming\.untitledEvent"\)\}/g
  );
  assert.equal(
    meetingCards?.length,
    2,
    "both calendar event summary displays must detect direction"
  );
});
