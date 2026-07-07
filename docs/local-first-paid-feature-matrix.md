# Local-First Paid Feature Availability Matrix

This matrix records the intended behaviour for features that were previously paid,
subscription, or OpenWhispr Cloud oriented. Hosted billing, checkout, workspace
subscription, hosted MCP, and hosted note sharing remain real hosted features.
The app does not spoof subscription state.

| Feature | Usable now route | Hosted route | Account needed? | Subscription needed? | Verification command or manual check |
| --- | --- | --- | --- | --- | --- |
| Dictation transcription | Local Whisper or Parakeet by default | OpenWhispr Cloud transcription | No for local; yes for hosted | No for local; hosted free limit or paid plan applies | `node --test test/config/featureAvailability.test.js test/stores/settingsDefaults.test.js test/hooks/usageLocalMode.test.js` |
| AI cleanup | Local model, BYOK provider, self-hosted, or enterprise provider | OpenWhispr Cloud cleanup | No for local/BYOK/self-hosted; yes for hosted | No for local/BYOK/self-hosted; hosted plan/limits apply | `node --test test/services/reasoningRouting.test.js` |
| Dictation agent | Local/BYOK/self-hosted/enterprise reasoning route | OpenWhispr Cloud agent | No for local/BYOK/self-hosted; yes for hosted | No for local/BYOK/self-hosted; hosted plan/limits apply | `node --test test/helpers/dictationRouting.test.js test/services/reasoningRouting.test.js` |
| Chat agent | Local/BYOK/self-hosted/enterprise reasoning route | OpenWhispr Cloud reasoning | No for local/BYOK/self-hosted; yes for hosted | No for local/BYOK/self-hosted; hosted plan/limits apply | `node --test test/services/reasoningRouting.test.js` |
| Note formatting | Local/BYOK/self-hosted/enterprise LLM route | OpenWhispr Cloud formatting | No for local/BYOK/self-hosted; yes for hosted | No for local/BYOK/self-hosted; hosted plan/limits apply | `node --test test/hooks/notesOnboardingAvailability.test.js test/utils/uploadTranscriptSummary.test.js` |
| Audio upload transcription | Local transcription with no app-level Pro size gate | OpenWhispr Cloud upload | No for local; yes for hosted | No for local; hosted large files require Pro/trial | `node --test test/components/uploadAvailability.test.js test/helpers/uploadTranscriptionRouting.test.js` |
| Meeting transcription | Local or BYOK meeting route | OpenWhispr Cloud meeting transcription | No for local/BYOK; yes for hosted | No for local/BYOK; hosted plan/limits apply | `node --test test/stores/meetingRecordingRouting.test.js` |
| Speaker diarization | Local diarization | N/A | No | No | `node --test test/stores/meetingRecordingRouting.test.js` |
| Semantic notes search | Local semantic search, then local keyword search | Cloud search only when explicitly enabled | No for local | No for local | `node --test test/services/searchNotesTool.test.js` |
| Notes onboarding | Completes with local or BYOK LLM configured | OpenWhispr Cloud formatting | No for local/BYOK; yes for hosted | No for local/BYOK; hosted plan/limits apply | `node --test test/hooks/notesOnboardingAvailability.test.js` |
| Local note sharing | Export Markdown or copy Markdown | Hosted share link/invites/domain for cloud notes | No for local export/copy; yes for hosted share | No for local export/copy; hosted sharing remains hosted | `node --test test/services/localShareService.test.js` plus manual share dialog check |
| Cloud backup/sync | Local JSON backup export/import | OpenWhispr Cloud sync | No for local backup; yes for cloud sync | No for local backup; cloud sync requires subscription or trial | `node --test test/services/localBackupService.test.js test/services/syncCapability.test.js` |
| Workspaces | Local personal workspace and local team labels | Hosted collaborative workspaces | No for local workspace; yes for hosted workspace | No for local workspace; hosted workspace billing applies | `node --test test/services/localWorkspaceService.test.js` |
| Workspace members/invites | Hosted-only copy in local workspace mode | Hosted members, invites, roles | Yes for hosted | Hosted workspace entitlement applies | Manual workspace members tab check |
| Workspace billing | Hosted-only copy in local workspace mode | Hosted billing portal/checkout | Yes for hosted | Hosted workspace subscription applies | Manual workspace billing tab check |
| Workspace API keys | Local CLI/MCP guidance in local workspace mode | Hosted workspace API keys | No for local guidance; yes for hosted keys | Hosted workspace subscription applies | `node --test test/components/integrationsAvailability.test.js` plus manual developer tab check |
| CLI integration | Local CLI command for notes while desktop app runs | Cloud CLI with auth/API key | No for local CLI; yes for cloud CLI | No for local CLI; hosted plan applies to cloud mode | `node --test test/components/integrationsAvailability.test.js` plus integrations UI check |
| MCP integration | Local loopback MCP bridge while desktop app runs | Hosted MCP URL | No for local MCP; yes for hosted MCP | No for local MCP; hosted MCP requires paid hosted entitlement | `node --test test/components/integrationsAvailability.test.js` plus integrations UI check |
| Billing and checkout | N/A; local routes avoid checkout prompts | Existing hosted checkout and billing portal | Yes for hosted billing | Required for hosted paid plans | `npm run lint`, `npm run typecheck`, and hosted UI state checks without opening checkout |

## Verification Run

- `npm run i18n:check`
- `npm run typecheck`
- `npm run lint`
- `node --test $(find test -name '*.test.js' -print)`

The command `node --test test/` is not used for this repository because the
current Node runner resolves `test/` as a module path. Expanding the test files
is the working full-suite invocation.
