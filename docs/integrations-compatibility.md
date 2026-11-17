# Integrations compatibility and acceptance

Evidence checked on 2026-10-08 (America/Los_Angeles). This matrix separates provider documentation, local fixtures and actual opened-draft acceptance. Provider browser support does not certify OpenWhispr's compose links.

## Email drafts

| Target                              | macOS                                                                                                     | Windows                                                                   | Linux                                                | OpenWhispr evidence                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail web                           | Chrome, Firefox, Safari, Edge documented by Google                                                        | Chrome, Firefox, Edge documented by Google                                | Chrome, Firefox documented by Google                 | Recipient, Cc, subject and body URL fixtures; platform-dependent overflow fixtures. Actual signed-in draft untested in this change.            |
| Outlook work/school and Outlook.com | Edge, Safari 16+, Firefox, Chrome documented by Microsoft                                                 | Windows 11: Edge, Firefox, Chrome documented by Microsoft                 | Firefox, Chrome documented, with some feature limits | Separate work/personal URL fixtures and Microsoft tenant/domain selection fixtures. Actual signed-in draft untested in this change.            |
| Yahoo Mail through System mail app  | Requires a configured mailto handler; Yahoo documents Chrome/Firefox setup. macOS configuration untested. | Yahoo documents Windows default-email and Chrome/Firefox setup. Untested. | Browser/desktop handler configuration untested.      | Generic mailto encoding and launch fixtures only. No dedicated Yahoo web target or Yahoo-specific draft verification.                          |
| System mail app                     | OS-selected email handler; webmail needs additional configuration                                         | OS-selected email handler                                                 | Configured desktop/portal handler                    | Mocked successful/failed launches; Linux missing-handler and Flatpak fallback fixtures. Actual app/browser acceptance untested in this change. |

Google's browser guidance is for the current and previous version and requires JavaScript and cookies. Microsoft and Yahoo browser requirements can change; consult the linked sources before expanding supported combinations. Mobile browsers and operating systems are outside this desktop check.

### Behavior retained

- A fresh preference is Automatic. It selects Gmail's approval card when Gmail is connected (including a login needing reconnect), then Gmail web for a connected Google Calendar, then Outlook work/personal for connected Microsoft accounts, then the system mail handler.
- An explicit Gmail web, Outlook work/personal or System mail app preference stays explicit when accounts change. A saved Send from chat preference falls back to Automatic when its Gmail login is removed. No preference migration is performed here.
- Web targets select a provider, not an account. The browser's signed-in session determines the sending account; review the sender before sending.
- Opening a draft never establishes delivery. The separate OAuth-connected Gmail approval card sends only after the user approves Send. This change does not alter that path.
- Draft links are capped at 2,000 characters, except Gmail on macOS/Linux at the existing 6,000-character cap. Overflow copies the body, then the subject if needed, only after an accepted launch; recipients that cannot fit are refused. Windows' external-open API documents a 2,081-character limit.
- The Recent actions view is removed. Receipt creation, account scoping, database records, reconciliation and history IPC remain intact.

### Acceptance still needed

For each applicable provider/browser/OS cell above, use an isolated test account and inspect the actual opened composer: To/Cc (including plus addressing), subject (Unicode, ampersands and percent signs), multiline body, active sender, signed-out redirect, long-body clipboard fallback and missing/default handler. Close without sending. None of these provider/native checks was performed by this change; URL decoding tests do not substitute for them.

Sources: [Gmail browser requirements](https://support.google.com/mail/answer/6557?co=GENIE.Platform%3DDesktop&hl=en), [Outlook browser support](https://support.microsoft.com/en-us/outlook/supported-browsers-for-outlook-on-the-web-and-outlook-com), [Yahoo default email setup](https://help.yahoo.com/kb/new-yahoo-mail/make-yahoo-mail-default-email-windows-web-browser-sln24051.html), [Yahoo browser support](https://help.yahoo.com/kb/mail/browser-supported-sln4556.html), [Apple default email setup](https://support.apple.com/en-us/102362), [Electron external opening](https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options).

## MCP authentication

The MCP URL is `https://mcp.openwhispr.com/mcp`. OAuth and API keys are alternatives; an API key is not a prerequisite for OAuth.

| Client            | OAuth                                                                                          | Personal API key                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude Connectors | OpenWhispr's guide documents adding a custom connector and signing in                          | Claude documents custom request headers; OpenWhispr uses a Bearer header             |
| Claude Code       | Client documents OAuth for remote servers                                                      | OpenWhispr documents Bearer-header configuration                                     |
| Cursor            | Client documents OAuth                                                                         | OpenWhispr documents Bearer-header configuration                                     |
| VS Code           | No OAuth acceptance verified for OpenWhispr in this change                                     | OpenWhispr documents header configuration with a password input                      |
| ChatGPT           | Official developer-mode guide documents OAuth; availability depends on plan/workspace settings | No static API-key setup verified here; do not direct users to a generic header field |

For OAuth, add the server URL in a supporting client, sign in to OpenWhispr and approve access. For a client accepting request headers, create a personal key with the needed permissions and configure `Authorization: Bearer YOUR_API_KEY`.

Unauthenticated metadata was checked live: [protected resource](https://mcp.openwhispr.com/.well-known/oauth-protected-resource) points to `auth.openwhispr.com`; [authorization metadata](https://auth.openwhispr.com/.well-known/oauth-authorization-server) advertises dynamic registration, authorization-code and refresh-token grants, and PKCE S256. This verifies advertised configuration only. No credentials were created, accounts linked, client sign-ins completed, or authenticated MCP tools executed.

Sources: [OpenWhispr MCP setup](https://docs.openwhispr.com/integrations/mcp), [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Cursor MCP](https://cursor.com/docs/mcp), [ChatGPT developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).
